import {
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  Mesh
} from 'three'
import { getInstancingDerivedMaterial } from '../instancing/InstancingDerivedMaterial.js'
import { getShadersForMaterial, createMemberRecord } from 'troika-three-utils'

const { keys: objectKeys } = Object

const DYNAMIC_DRAW = 0x88E8 //can't import DynamicDrawUsage from three without breaking older versions
const MATRIX_ROW_COUNT = 3 //a 4x4 model matrix's last row is always (0, 0, 0, 1)
const tempColor = new Color()

/**
 * A MemberBatch holds a single, ordered list of "member" records describing renderable items,
 * and is the single source of truth shared by every way those items can be drawn:
 *
 *   - pushed into a Troika scene right before rendering (via an {@link InstancingManager}),
 *   - attached to an ordinary `THREE.Mesh`/`InstancedMesh` that is rendered without any scene
 *     facade at all,
 *   - read back as plain world matrices/colors by tests, raycasting code, etc.
 *
 * Each member record carries the same fields regardless of what it renders:
 *
 *   - `matrix`      - a `THREE.Matrix4` holding the member's *world* transform
 *   - `color`       - an optional per-member color (a `THREE.Color`, hex number, or null)
 *   - `uniforms`    - a map of any other per-instance shader uniform values
 *   - `visible`     - whether the member participates in packing and rendering
 *
 * Text batches add their own fields (clip rect, curve radius, stroke/outline, ...) alongside
 * these, so a text member and an instanced mesh member are always indexed by the same record.
 *
 * The batch only manages data and the GPU buffers holding that data; it never adds anything to
 * a scene graph. Rendering paths decide how to consume the resulting geometry/material.
 */
class MemberBatch {
  /**
   * @param {object} config
   * @param {THREE.BufferGeometry} config.geometry - the shared geometry drawn for every member
   * @param {THREE.Material} config.material - the shared base material
   * @param {number} [config.maxMembers] - hard cap on member count for preallocated GPU buffers;
   *   buffers otherwise grow on demand in powers of two
   * @param {string[]} [config.uniforms] - names of shader uniforms, besides the model matrix,
   *   that can vary per member
   */
  constructor (config) {
    this.config = config
    const {geometry, material, maxMembers = 0} = config

    /**
     * The ordered member records. Indices into this array are stable for the lifetime of a
     * record; removing a member swaps in the last record (see {@link #removeMember}), matching
     * how GPU instancing buffers are compacted.
     * @type {Array<MemberRecord>}
     */
    this.members = []

    this._geometry = geometry
    this._baseMaterial = material
    this._maxMembers = maxMembers
    this._uniformSizes = Object.create(null)
    this._uniformNames = []
    ;(config.uniforms || []).forEach(name => this._enableUniform(name))

    this._needsRepack = true
    this._hasIncrementalChanges = false
    this._memberBatchVersion = 0
    this._visibleCount = 0

    // Lazily-created render objects, one per rendering path
    this._instancedGeometry = null
    this._instancedMesh = null
    this._fallbackGroup = null
  }

  // ---------------------------------------------------------------------------
  // Member record management
  // ---------------------------------------------------------------------------

  /**
   * Add a new member record, or re-add an existing one, and return it. The record starts with
   * an identity world matrix and no per-member values.
   * @param {MemberRecord} [record] - an existing record to recycle
   * @returns {MemberRecord}
   */
  addMember (record) {
    if (!record) {
      record = createMemberRecord()
    }
    record.index = this.members.length
    this.members.push(record)
    this._needsRepack = true
    this._memberBatchVersion++
    return record
  }

  /**
   * Remove the given member record. The last record is swapped into its slot so all remaining
   * indices stay packed, and the swapped record's `index` is corrected.
   * @param {MemberRecord} record
   */
  removeMember (record) {
    const {members} = this
    const idx = members.indexOf(record)
    if (idx !== -1) {
      const last = members.pop()
      if (last !== record) {
        members[idx] = last
        last.index = idx
      }
      record.index = -1
      this._needsRepack = true
      this._memberBatchVersion++
    }
  }

  /**
   * Look up a member by its stable index.
   * @param {number} index
   * @returns {MemberRecord|undefined}
   */
  getMemberAt (index) {
    return this.members[index]
  }

  /**
   * @returns {number} the number of visible, renderable members (visible records are always
   *   packed at the front, so this is also the GPU instance count)
   */
  get memberCount () {
    return this._visibleCount
  }

  /**
   * Mark a member's world matrix as changed so it will be written into the GPU buffers on the
   * next pack. This is cheap and synchronous: matrix movement never waits on anything else
   * (e.g. text typesetting), so an instanced column is already at its new world position on the
   * same frame its transform was assigned.
   * @param {MemberRecord} record
   */
  markMemberMatrixDirty (record) {
    record._matrixDirty = true
    this._hasIncrementalChanges = true
    this._memberBatchVersion++
  }

  /**
   * Set a per-member shader uniform value (color, radius, ...). Uniform names are registered
   * lazily the first time they are used, matching the old `setInstanceUniform` behavior.
   * @param {MemberRecord} record
   * @param {string} name
   * @param {*} value
   */
  setMemberUniform (record, name, value) {
    if (record.uniforms[name] !== value) {
      this._enableUniform(name)
      record.uniforms[name] = value
      record._uniformDirty = record._uniformDirty || Object.create(null)
      record._uniformDirty[name] = true
      this._hasIncrementalChanges = true
      this._memberBatchVersion++
    }
  }

  /**
   * @param {MemberRecord} record
   * @param {string} name
   * @returns {*} the member's value for the uniform, or the material's default if unset
   */
  getMemberUniform (record, name) {
    const values = record.uniforms
    if (values && name in values) {
      return values[name]
    }
    return getDefaultUniformValue(this._baseMaterial, name)
  }

  _enableUniform (name) {
    if (!(name in this._uniformSizes)) {
      const size = getUniformItemSize(this._baseMaterial, name)
      if (size > 0) {
        this._uniformSizes[name] = size
        this._uniformNames.push(name)
        // Existing buffers cannot carry the new attribute; force a full repack and drop the
        // cached render objects so they pick up the new geometry/material.
        this._teardownInstancedObjects()
        this._needsRepack = true
      } else {
        console.warn(`Could not determine item size for uniform ${name}`)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Packing: member records -> GPU instancing attributes
  // ---------------------------------------------------------------------------

  /**
   * Ensure the instanced geometry's buffers exist, are large enough, and hold the current values
   * of every member. Runs incrementally when possible: a single matrix change updates just that
   * member's matrix rows, without rebuilding any buffers.
   *
   * @returns {THREE.InstancedBufferGeometry}
   */
  pack () {
    const visibleMembers = this._getVisibleMembers()
    const count = visibleMembers.length
    let geometry = this._instancedGeometry

    // (Re)build the instanced geometry from scratch if needed
    if (!geometry || geometry._capacity < count) {
      geometry = this._instancedGeometry = this._createInstancedGeometry(
        Math.max(count, this._maxMembers, 1)
      )
      this._teardownInstancedMeshOnly()
      this._needsRepack = true
    }

    if (this._needsRepack) {
      // Full rewrite of every attribute for every (visible) member
      this._writeAttributes(geometry, visibleMembers, 0, count, true)
      this._needsRepack = false
      this._hasIncrementalChanges = false
    } else if (this._hasIncrementalChanges) {
      // Incremental update: only rewrite records flagged dirty
      for (let i = 0; i < count; i++) {
        const record = visibleMembers[i]
        if (record._matrixDirty || (record._uniformDirty && objectKeys(record._uniformDirty).length)) {
          this._writeAttributes(geometry, [record], i, 1, false)
          record._matrixDirty = false
          record._uniformDirty = null
        }
      }
      this._hasIncrementalChanges = false
    }

    setInstanceCount(geometry, count)
    this._visibleCount = count
    return geometry
  }

  /**
   * Force the next {@link #pack} to rewrite every buffer. Text batches call this when glyph
   * geometry is repacked, since member indices can be reassigned.
   */
  invalidate () {
    this._needsRepack = true
    this._memberBatchVersion++
  }

  _getVisibleMembers () {
    // Visible records are compacted to the front so the GPU instance count equals the length
    const {members} = this
    let visible = this._visibleMembers
    if (!visible) {
      visible = this._visibleMembers = []
    }
    visible.length = 0
    for (let i = 0; i < members.length; i++) {
      if (members[i].visible !== false) {
        visible.push(members[i])
      }
    }
    return visible
  }

  _createInstancedGeometry (capacity) {
    const base = this._geometry
    if (!base || !base.isBufferGeometry) {
      throw new Error('MemberBatch base object must use a BufferGeometry')
    }

    const geometry = new InstancedBufferGeometry()
    Object.assign(geometry, base)
    geometry.attributes = Object.assign({}, base.attributes)
    geometry._capacity = capacity
    geometry._instanceAttrs = {matrix: [], uniforms: Object.create(null)}

    // Model matrix rows; the fourth row is always (0, 0, 0, 1) for affine transforms
    for (let row = 0; row < MATRIX_ROW_COUNT; row++) {
      const attr = createDynamicAttribute(capacity, 4)
      geometry.attributes[`troika_modelMatrixRow${row}`] = attr
      geometry._instanceAttrs.matrix[row] = attr
    }

    // Per-member uniform attributes
    for (let name in this._uniformSizes) {
      const attr = createDynamicAttribute(capacity, this._uniformSizes[name])
      geometry.attributes[`troika_${name}`] = attr
      geometry._instanceAttrs.uniforms[name] = attr
    }
    return geometry
  }

  _writeAttributes (geometry, records, startOffset, count, fullRewrite) {
    const matrixAttrs = geometry._instanceAttrs.matrix
    const uniformAttrs = geometry._instanceAttrs.uniforms
    for (let n = 0; n < count; n++) {
      const offset = startOffset + n
      const record = records[n]
      record.index = offset

      // World matrix, column-major elements -> three row vec4 attributes
      if (fullRewrite || record._matrixDirty) {
        const elements = record.matrix.elements
        matrixAttrs[0].setXYZW(offset, elements[0], elements[4], elements[8], elements[12])
        matrixAttrs[1].setXYZW(offset, elements[1], elements[5], elements[9], elements[13])
        matrixAttrs[2].setXYZW(offset, elements[2], elements[6], elements[10], elements[14])
        for (let row = 0; row < MATRIX_ROW_COUNT; row++) {
          matrixAttrs[row].version++
        }
        record._matrixDirty = false
      }

      // Uniforms
      const dirtyUniforms = record._uniformDirty
      for (let i = this._uniformNames.length; i--;) {
        const name = this._uniformNames[i]
        if (fullRewrite || (dirtyUniforms && dirtyUniforms[name])) {
          const attr = uniformAttrs[name]
          setAttributeValue(attr, offset, this.getMemberUniform(record, name))
          attr.version++
        }
      }
      if (!fullRewrite) {
        record._uniformDirty = null
      }
    }
    if (fullRewrite) {
      for (let n = 0; n < count; n++) {
        records[n]._uniformDirty = null
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering path A: a standalone InstancedMesh usable without any scene facade
  // ---------------------------------------------------------------------------

  /**
   * Build (or return the cached) ordinary `THREE.InstancedMesh` that renders all members in a
   * single instanced draw call. The mesh is a normal scene-graph object: adding it to any
   * `THREE.Scene` and calling `renderer.render()` draws the batch with no Troika world/facade
   * involved. Every call first runs {@link #pack} so its matrices/colors are current.
   * @returns {THREE.InstancedMesh}
   */
  getInstancedMesh () {
    const geometry = this.pack()
    let mesh = this._instancedMesh
    const capacity = geometry._capacity
    if (!mesh || mesh._capacity !== capacity) {
      if (mesh) mesh.dispose()
      const material = getInstancingDerivedMaterial(this._baseMaterial, this._uniformNames.slice())
      mesh = this._instancedMesh = createBatchInstancedMesh(geometry, material, capacity)
      mesh._capacity = capacity
      mesh.frustumCulled = false
      mesh.$memberBatch = this
    }
    // Keep three's standard instanceMatrix attribute in sync with the troika row attributes,
    // so code reading the mesh back (and the non-troika InstancedMesh contract) sees the same
    // world matrices: "同一份平移...读回的世界坐标必须是同一个数".
    syncStandardInstanceMatrix(mesh, this._getVisibleMembers())
    mesh.count = this.memberCount
    return mesh
  }

  // ---------------------------------------------------------------------------
  // Rendering path B: non-instanced fallback, one ordinary Mesh per member
  // ---------------------------------------------------------------------------

  /**
   * Build (or update) a group containing one ordinary, non-instanced `THREE.Mesh` per member.
   * This is the "instancing off" path: positions and colors must match {@link #getInstancedMesh}
   * exactly because both read the same member records.
   * @returns {THREE.Group}
   */
  getFallbackGroup () {
    const visibleMembers = this._getVisibleMembers()
    this._visibleCount = visibleMembers.length
    let group = this._fallbackGroup
    if (!group) {
      group = this._fallbackGroup = new Group()
    }

    // Reuse meshes where possible, drop extras, add missing ones
    const kids = group.children
    while (kids.length > visibleMembers.length) {
      const removed = kids[kids.length - 1]
      group.remove(removed)
    }
    for (let i = 0; i < visibleMembers.length; i++) {
      const record = visibleMembers[i]
      let mesh = kids[i]
      if (!mesh) {
        mesh = createFallbackMesh(this._geometry, this._baseMaterial)
        mesh.$memberRecord = record
        group.add(mesh)
      }
      mesh.$memberRecord = record
      mesh.matrixAutoUpdate = false
      mesh.matrix.copy(record.matrix)
      mesh.matrixWorld.copy(record.matrix)
      mesh.visible = record.visible !== false
      // Per-member color: use a cloned material so the shared base material is never mutated.
      // Colors can arrive either through the convenience `color` field or through a per-member
      // `diffuse` uniform (as Instanceable3DFacade uses); both must render identically.
      const colorValue = record.color != null ? record.color
        : ('diffuse' in record.uniforms ? record.uniforms.diffuse : null)
      if (colorValue != null && mesh.material && 'color' in mesh.material) {
        const material = getFallbackMaterial(record, this._baseMaterial)
        mesh.material = material
        material.color.set(tempColor.set(colorValue))
      } else {
        mesh.material = this._baseMaterial
      }
      applyUniformsToObject(mesh, record, this._uniformNames)
    }
    return group
  }

  /**
   * Release all GPU resources created by this batch. Member records themselves are retained.
   */
  dispose () {
    this._teardownInstancedObjects()
    this._fallbackGroup = null
    this.members.forEach(record => {
      if (record._fallbackMaterial) {
        record._fallbackMaterial.dispose()
        record._fallbackMaterial = null
      }
    })
  }

  _teardownInstancedMeshOnly () {
    if (this._instancedMesh) {
      this._instancedMesh.dispose()
      this._instancedMesh = null
    }
  }

  _teardownInstancedObjects () {
    this._teardownInstancedMeshOnly()
    if (this._instancedGeometry) {
      try { this._instancedGeometry.dispose() } catch (e) { /* already disposed */ }
      this._instancedGeometry = null
    }
  }
}

function createDynamicAttribute (capacity, itemSize) {
  const attr = new InstancedBufferAttribute(new Float32Array(capacity * itemSize), itemSize)
  if (attr.setUsage) {
    attr.setUsage(DYNAMIC_DRAW)
  } else {
    attr.dynamic = true
  }
  return attr
}

function createBatchInstancedMesh (geometry, material, capacity) {
  const mesh = new InstancedMesh(geometry, material, capacity)
  // The troika instancing shader derives the model matrix from the three row attributes, not
  // from three's built-in instanceMatrix, so keep the built-in attribute from doing any work
  // while still holding correct data for readbacks.
  mesh.instanceMatrix.setUsage(DYNAMIC_DRAW)
  return mesh
}

function syncStandardInstanceMatrix (mesh, visibleMembers) {
  const attr = mesh.instanceMatrix
  for (let i = 0; i < visibleMembers.length; i++) {
    visibleMembers[i].matrix.toArray(attr.array, i * 16)
  }
  attr.needsUpdate = true
}

function createFallbackMesh (geometry, baseMaterial) {
  const mesh = new Mesh(geometry, baseMaterial)
  mesh.matrixAutoUpdate = false
  return mesh
}

function getFallbackMaterial (record, baseMaterial) {
  let material = record._fallbackMaterial
  if (!material || material.baseMaterial !== baseMaterial) {
    material = record._fallbackMaterial = baseMaterial.clone()
    material.baseMaterial = baseMaterial
  }
  return material
}

function applyUniformsToObject (mesh, record, uniformNames) {
  for (let i = uniformNames.length; i--;) {
    const name = uniformNames[i]
    if (name in record.uniforms && mesh.material && mesh.material.uniforms && mesh.material.uniforms[name]) {
      const value = record.uniforms[name]
      const uniform = mesh.material.uniforms[name].value
      if (uniform && uniform.copy && value && typeof value === 'object') {
        uniform.copy(value)
      } else {
        mesh.material.uniforms[name].value = value
      }
    }
  }
}

function setAttributeValue (attr, offset, value) {
  const size = attr.itemSize
  if (size === 1) {
    attr.setX(offset, value)
  } else if (size === 2) {
    attr.setXY(offset, value.x, value.y)
  } else if (size === 3) {
    if (value && value.isColor) {
      attr.setXYZ(offset, value.r, value.g, value.b)
    } else {
      attr.setXYZ(offset, value.x, value.y, value.z)
    }
  } else if (size === 4) {
    attr.setXYZW(offset, value.x, value.y, value.z, value.w)
  }
}

function getDefaultUniformValue (material, name) {
  let uniforms = material.uniforms
  if (uniforms && uniforms[name]) {
    return uniforms[name].value
  }
  uniforms = getShadersForMaterial(material).uniforms
  if (uniforms && uniforms[name]) {
    return uniforms[name].value
  }
  return null
}

function getUniformItemSize (material, name) {
  return getItemSizeForValue(getDefaultUniformValue(material, name))
}

function getItemSizeForValue (value) {
  return value == null ? 0
    : typeof value === 'number' ? 1
    : value.isVector2 ? 2
      : (value.isVector3 || value.isColor) ? 3
        : value.isVector4 ? 4
          : Array.isArray(value) ? value.length
            : 0
}

// Handle maxInstancedCount -> instanceCount rename that happened in three r117
function setInstanceCount (geom, count) {
  geom[geom.hasOwnProperty('instanceCount') ? 'instanceCount' : 'maxInstancedCount'] = count
}

/**
 * @typedef {Object} MemberRecord
 * @property {number} index - current packing index, or -1 when not in a batch
 * @property {THREE.Matrix4} matrix - world transform; the single source of truth for position
 * @property {THREE.Color|number|null} color - per-member color, or null to use the material's
 * @property {boolean} visible
 * @property {Object<string, *>} uniforms - other per-instance shader uniform values
 * @property {Object} userData - free-form slot (text batches keep glyph info here)
 */

export {
  MemberBatch,
  getDefaultUniformValue,
  getUniformItemSize,
  getItemSizeForValue,
  setAttributeValue
}
