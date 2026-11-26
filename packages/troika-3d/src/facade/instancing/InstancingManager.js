import { utils } from 'troika-core'
import {
  Matrix4
} from 'three'
import Group3DFacade from '../Group3DFacade.js'
import { getInstancingDerivedMaterial } from './InstancingDerivedMaterial.js'
import { MemberBatch, getDefaultUniformValue } from '../members/MemberBatch.js'

const { assign } = utils

const INSTANCE_BATCH_SIZE = 128 //TODO make this an option?

/**
 * An InstancingManager handles aggregating all Instanceable3DFacade descendants into
 * instancing batches. For each batch it creates a clone of the instancedThreeObject,
 * populates a pooled InstancedBufferGeometry with buffer attributes holding the world
 * matrices of all the batch's instances, and temporarily inserts that into the
 * scene to be rendered.
 *
 * As an additional "turbo" optimization, the instancing batch objects/geometries will be
 * reused untouched between rendering frames if none of the managed Instanceable3DFacade
 * objects have changed in a way that would affect the batches or world matrix attributes.
 *
 * There is a global InstancingManager automatically added to the main scene, and it does
 * nothing if there are no Instanceable3DFacades in the scene, so in most cases you should
 * not need to touch this yourself. But it is also possible to insert additional
 * InstancingManager facades further down in the scene if you wish to control the scope
 * of instancing, e.g. to increase the likelihood of the aforementioned "turbo" optimization
 * kicking in.
 *
 * Also see InstancingShaderUpgrades, which modifies material shaders so they accept the matrix
 * and custom uniform values coming in as attributes. This allows built-in materials as well as
 * custom shaders to work with instancing without manual modification.
 *
 * == Shared member data ==
 *
 * All per-instance state (world matrix, per-instance uniforms/colors) lives in
 * {@link MemberBatch} member records, also exposed on each facade as `this._memberRecord`.
 * The very same records can be handed to an ordinary `THREE.InstancedMesh` (via
 * `memberBatch.getInstancedMesh()`) to render the identical columns/spheres without any scene
 * facade at all; both paths read back the same world coordinates because there is only one
 * matrix per member.
 */
class InstancingManager extends Group3DFacade {
  constructor(parent) {
    super(parent)
    this._instanceables = Object.create(null)
    this._memberBatchesByKey = Object.create(null)
    this._needsRebatch = true
    this.addEventListener('beforerender', this._setupBatchObjects.bind(this))
    this.addEventListener('afterrender', this._teardownBatchObjects.bind(this))
  }

  onNotifyWorld(source, message, data) {
    let handler = this._notifyWorldHandlers[message]
    if (handler) {
      handler.call(this, source, data)
    } else if (this.parent) {
      this.parent.onNotifyWorld(source, message, data)
    }
  }

  /**
   * Get (or lazily create) the MemberBatch holding the shared member records for a render batch
   * slot. A single proto object can span several render batches once it exceeds
   * INSTANCE_BATCH_SIZE members, so each render batch gets its own MemberBatch whose packed
   * geometry it renders.
   */
  _getMemberBatch (protoObject, batchKey, slot) {
    const slots = this._memberBatchesByKey[batchKey] || (this._memberBatchesByKey[batchKey] = [])
    let memberBatch = slots[slot]
    if (!memberBatch) {
      const uniformNames = this._getInstanceUniformNames(protoObject)
      memberBatch = slots[slot] = new MemberBatch({
        geometry: protoObject.geometry,
        material: protoObject.material,
        maxMembers: INSTANCE_BATCH_SIZE,
        uniforms: uniformNames || undefined
      })
    }
    return memberBatch
  }

  /**
   * Empty every backing MemberBatch at the start of a full rebatch, while keeping the batch
   * objects themselves so their pooled GPU buffers are reused. Also clear each facade's record
   * back-reference so _getMemberRecord re-adds its (recycled) record to the correct batch.
   */
  _resetMemberBatches () {
    for (let key in this._memberBatchesByKey) {
      this._memberBatchesByKey[key].forEach(memberBatch => {
        if (memberBatch) {
          memberBatch.members.length = 0
          memberBatch.invalidate()
        }
      })
    }
    for (let facadeId in this._instanceables) {
      const facade = this._instanceables[facadeId]
      if (facade._memberRecord) {
        facade._memberRecord._memberBatch = null
        facade._memberBatch = null
      }
    }
  }

  /**
   * Get the member record backing a facade, creating it within the given MemberBatch on first
   * use and keeping the back-references in sync.
   */
  _getMemberRecord (facade, memberBatch) {
    let record = facade._memberRecord
    if (!record || record._memberBatch !== memberBatch) {
      // Recycling a record that was detached in _resetMemberBatches: addMember() will reassign
      // its packing index within the new batch. A brand-new record is created when there is none.
      record = memberBatch.addMember(record)
      record._memberBatch = memberBatch
      facade._memberRecord = record
      facade._memberBatch = memberBatch
    }
    return record
  }

  _syncFacadeToRecord (facade, protoObject, record) {
    // World matrix: the facade's threeObject.matrixWorld is the single source of truth
    record.matrix.copy(facade.threeObject.matrixWorld)
    record.visible = facade.threeObject.visible !== false

    // Per-instance uniforms (e.g. diffuse color, custom radius)
    const names = this._getInstanceUniformNames(protoObject)
    if (names) {
      const facadeUniforms = facade._instanceUniforms
      for (let i = names.length; i--;) {
        const name = names[i]
        const value = (facadeUniforms && name in facadeUniforms) ?
          facadeUniforms[name] : getDefaultUniformValue(protoObject.material, name)
        record.uniforms[name] = value
      }
    }
  }

  _setupBatchObjects(renderer, scene, camera) {
    let instanceables = this._instanceables
    let batchObjectsByKey = this._batchObjectsByKey
    let needsRebatch = this._needsRebatch

    if (!needsRebatch) {
      // We'll already know about most types of changes (instanceable addition/removal, instancedThreeObject
      // changes, matrix changes) but if any of the instancedThreeObjects changed their geometry or material
      // internally we'll need to detect that here and deoptimize.
      for (let key in batchObjectsByKey) {
        let batchObj = batchObjectsByKey[key][0]
        if (this._getBatchKey(batchObj.$troikaBatchBaseObj) !== key) {
          needsRebatch = true
          break
        }
      }
    }

    if (needsRebatch) {
      batchObjectsByKey = this._batchObjectsByKey = Object.create(null)
      // A full rebatch reassigns every facade to (possibly new) batches, so detach any prior
      // member-record -> batch associations. The records themselves are retained and recycled by
      // _getMemberRecord below, but their old batches must start empty for this frame's packing.
      this._resetMemberBatches()
      for (let facadeId in instanceables) {
        let facade = instanceables[facadeId]
        let instanceObject = facade.threeObject
        let protoObject = facade.instancedThreeObject

        if (protoObject && instanceObject.visible) {
          // Find the render batch + its backing MemberBatch for this facade's instancedThreeObject
          let batchKey = this._getBatchKey(protoObject)
          let batchObjects = batchObjectsByKey[batchKey] || (batchObjectsByKey[batchKey] = [])
          let batchObject = batchObjects[batchObjects.length - 1]
          let memberBatch = batchObject && batchObject.$memberBatch
          if (!memberBatch || memberBatch.members.length === INSTANCE_BATCH_SIZE) {
            const slot = batchObjects.length
            memberBatch = this._getMemberBatch(protoObject, batchKey, slot)
            batchObject = this._getBatchObject(protoObject, memberBatch)
            batchObjects.push(batchObject)
          }

          // The facade's member record is the shared source of truth for its world matrix and
          // per-instance uniforms. Sync its current state into the member batch.
          const record = this._getMemberRecord(facade, memberBatch)
          this._syncFacadeToRecord(facade, protoObject, record)
          memberBatch.markMemberMatrixDirty(record)
          // Uniform values may have changed without a setInstanceUniform notification; mark them
          // all dirty so the next pack rewrites this member's uniform attributes.
          if (record.uniforms) {
            record._uniformDirty = record._uniformDirty || Object.create(null)
            for (let name in record.uniforms) record._uniformDirty[name] = true
          }

          // Save pointers for possible reuse next frame
          facade._instancingBatchObject = batchObject
          facade._instancingBatchAttrOffset = record.index
        } else {
          facade._instancingBatchObject = facade._instancingBatchAttrOffset = null
        }
      }

      // Pack every member batch into its GPU buffers (incrementally where possible); each render
      // batch object's geometry getter resolves to its member batch's packed geometry.
      for (let key in this._memberBatchesByKey) {
        this._memberBatchesByKey[key].forEach(memberBatch => {
          if (memberBatch) memberBatch.pack()
        })
      }
    }

    // Add the batch objects to the scene
    let batchCount = 0
    let batchGrpCount = 0
    let instanceCount = 0
    for (let id in batchObjectsByKey) {
      let batchObjects = batchObjectsByKey[id]
      scene.children.push.apply(scene.children, batchObjects)

      // increment stats
      batchGrpCount++
      for (let i = batchObjects.length; i--;) {
        batchCount++
        instanceCount += getInstanceCount(batchObjects[i].geometry)
      }
    }

    this.notifyWorld('statsUpdate', {
      'Instancing Batch Groups': batchGrpCount,
      'Instancing Batches': batchCount,
      'Instanced Objects': instanceCount
    })

    this._needsRebatch = false
  }

  _onInstanceAdded(facade) {
    this._instanceables[facade.$facadeId] = facade
    this._needsRebatch = true
  }

  _onInstanceRemoved(facade) {
    delete this._instanceables[facade.$facadeId]
    // Release the facade's slot in its member batch
    if (facade._memberRecord && facade._memberBatch) {
      facade._memberBatch.removeMember(facade._memberRecord)
      facade._memberRecord._memberBatch = null
      facade._memberRecord = facade._memberBatch = null
    }
    this._needsRebatch = true
  }

  _onInstanceChanged(facade) {
    // The instancedThreeObject changed; its record belongs to a different batch now
    if (facade._memberRecord && facade._memberBatch) {
      facade._memberBatch.removeMember(facade._memberRecord)
      facade._memberRecord._memberBatch = null
      facade._memberRecord = facade._memberBatch = null
    }
    this._needsRebatch = true
  }

  _onInstanceMatrixChanged(facade) {
    // If a single instance's matrix changed and the batches are still otherwise valid, update
    // its shared member record immediately. Matrix updates never wait on any other work (e.g.
    // text typesetting); the member is at its new world position on this same frame. A full
    // rebatch flag is set so the render-time pack picks the incremental buffer write up.
    const memberBatch = facade._memberBatch
    const record = facade._memberRecord
    if (memberBatch && record) {
      record.matrix.copy(facade.threeObject.matrixWorld)
      memberBatch.markMemberMatrixDirty(record)
    }
    this._needsRebatch = true
  }

  _onInstanceUniformChanged(facade, uniformName) {
    const memberBatch = facade._memberBatch
    const record = facade._memberRecord
    if (memberBatch && record && facade.instancedThreeObject) {
      const facadeUniforms = facade._instanceUniforms
      const value = (facadeUniforms && uniformName in facadeUniforms) ?
        facadeUniforms[uniformName] :
        getDefaultUniformValue(facade.instancedThreeObject.material, uniformName)
      memberBatch.setMemberUniform(record, uniformName, value)
    }
    this._needsRebatch = true
  }

  _getBatchKey(object) {
    let cache = this._batchKeysCache || (this._batchKeysCache = Object.create(null)) //cache results for duration of this frame
    let key = cache && cache[object.id]
    if (!key) {
      let uniforms = this._getInstanceUniformNames(object)
      key = `${object.geometry.id}|${object.material.id}|${uniforms ? uniforms.sort().join(',') : ''}`
      cache[object.id] = key
    }
    return key
  }

  _getInstanceUniformNames(object) {
    let namesSet = object._instanceUniformNames
    if (!namesSet) return null
    let cache = this._uniformNamesCache || (this._uniformNamesCache = new Map())
    let namesArray = cache.get(namesSet)
    if (!namesArray) {
      namesArray = Array.from(namesSet)
      cache.set(namesSet, namesArray)
    }
    return namesArray
  }

  _getBatchObject(instancedObject, memberBatch) {
    let {geometry, material} = instancedObject

    // Upgrade the material to one with the shader modifications for instancing
    if (!geometry.isBufferGeometry) {
      throw new Error('Instanceable proto object must use a BufferGeometry')
    }
    let uniformNames = this._getInstanceUniformNames(instancedObject)
    let batchMaterial = getInstancingDerivedMaterial(material, uniformNames ? uniformNames.slice() : [])
    let depthMaterial, distanceMaterial

    // Create a new mesh object to hold it all. Its geometry getter always resolves to the
    // MemberBatch's current packed geometry, so buffer rebuilds are picked up automatically.
    let batchObject = Object.create(instancedObject, {
      // Redefine properties rather than setting them so we don't inadvertently trigger setters on
      // the base object:
      geometry: {
        get() {
          return memberBatch._instancedGeometry
        },
        configurable: true
      },
      material: { value: batchMaterial },
      visible: { value: true },
      frustumCulled: { value: false },

      // Lazy getters for shadow materials:
      customDepthMaterial: {
        get() {
          if (!depthMaterial) {
            depthMaterial = batchMaterial.getDepthMaterial()
            // We need to trick WebGLRenderer into setting the `viewMatrix` uniform, which it doesn't
            // normally do for MeshDepthMaterial but it's needed by the instancing shader code. It does
            // for ShaderMaterials so we pretend to be one.
            depthMaterial.isShaderMaterial = true
            depthMaterial.uniformsGroups = depthMaterial.uniformsGroups || [];
          }
          return depthMaterial
        },
        set(m) {
          // future: let the user override with their own?
        }
      },
      customDistanceMaterial: {
        get() {
          if (!distanceMaterial) {
            distanceMaterial = batchMaterial.getDistanceMaterial()
            // We need to trick WebGLRenderer into setting the `viewMatrix` uniform, which it doesn't
            // normally do for MeshDistanceMaterial but is needed by the instancing shader code. It does
            // for ShaderMaterials so we pretend to be one.
            distanceMaterial.isShaderMaterial = true
            distanceMaterial.uniformsGroups = distanceMaterial.uniformsGroups || [];

            // Additionally, WebGLShadowMap.render() rotates a single camera 6 times per object, which fails
            // to trigger the code in WebGLRenderer.setProgram() that updates the viewMatrix uniform for
            // directions 2 through 6. Since we need a correct viewMatrix in the instancing shader code,
            // we hack it by defining our own viewMatrix uniform on the distance material and manually
            // updating it before each view of the distance cube is rendered. Unfortunately intercepting the
            // view changes in a way that has access to the shadow camera's viewMatrix has proven quite
            // difficult; the least-awful way I've found is to monkeypatch the `modelViewMatrix.multiplyMatrices()`
            // function which is always called - see (*!) below.
            distanceMaterial.uniforms = assign({
              viewMatrix: { value: new Matrix4() }
            }, distanceMaterial.uniforms)
          }
          return distanceMaterial
        },
        set(m) {
          // future: let the user override with their own?
        }
      },
      // (*!) Hack for updating viewMatrix uniform on the distance material - see explanation above.
      modelViewMatrix: {
        value: function() {
          const modelViewMatrix = new Matrix4()
          modelViewMatrix.multiplyMatrices = function(viewMatrix, matrixWorld) {
            if (distanceMaterial) {
              distanceMaterial.uniforms.viewMatrix.value.copy(viewMatrix)
              distanceMaterial.uniformsNeedUpdate = true //undocumented flag for ShaderMaterial
            }
            return Matrix4.prototype.multiplyMatrices.call(this, viewMatrix, matrixWorld)
          }
          return modelViewMatrix
        }()
      }
    })
    batchObject.$troikaBatchBaseObj = instancedObject
    batchObject.$troikaInstancingManager = this
    batchObject.$memberBatch = memberBatch
    // NOTE other props are inherited so don't need to copy them
    return batchObject
  }

  _teardownBatchObjects(renderer, scene, camera) {
    // Clear caches from this render frame
    this._batchKeysCache = null
    this._uniformNamesCache = null

    // Remove batch objects from scene
    scene.children = scene.children.filter(obj => obj.$troikaInstancingManager !== this)
  }

  destructor() {
    for (let key in this._memberBatchesByKey) {
      this._memberBatchesByKey[key].forEach(memberBatch => {
        if (memberBatch) memberBatch.dispose()
      })
    }
    this._memberBatchesByKey = Object.create(null)
    super.destructor()
  }
}


const proto = InstancingManager.prototype
proto._notifyWorldHandlers = {
  instanceableAdded: proto._onInstanceAdded,
  instanceableRemoved: proto._onInstanceRemoved,
  instanceableChanged: proto._onInstanceChanged,
  instanceableMatrixChanged: proto._onInstanceMatrixChanged,
  instanceableUniformChanged: proto._onInstanceUniformChanged
}


// Handle maxInstancedCount -> instanceCount rename that happened in three r117
function getInstanceCount(geom) {
  return geom[geom.hasOwnProperty('instanceCount') ? 'instanceCount' : 'maxInstancedCount']
}

export default InstancingManager
