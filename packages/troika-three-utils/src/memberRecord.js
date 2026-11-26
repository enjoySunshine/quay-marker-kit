import { Matrix4 } from 'three'

/**
 * Create a member record: the common unit of data shared by every batching/rendering path.
 *
 * A record describes one renderable item - an instanced column/sphere, a 3D text label, etc. -
 * and is the single source of truth that all rendering paths (a Troika scene facade's
 * pre-render batches, or an ordinary THREE.Mesh/InstancedMesh rendered without any facade)
 * read from. Keeping one record per item means the same translation handed to a text batch and
 * to an instanced mesh always reads back as the same world coordinates.
 *
 * The record shape intentionally matches the fields consumed by both the GPU instancing
 * attributes and the batched-text data texture:
 *
 *   - `index`    - current packing index within its batch, or -1 when not packed
 *   - `matrix`   - a THREE.Matrix4 holding the item's world transform
 *   - `color`    - per-item color (THREE.Color, hex, or null to inherit the material's)
 *   - `visible`  - whether the item participates in packing/rendering
 *   - `uniforms` - map of any other per-item shader uniform values
 *   - `userData` - free-form slot; text keeps its glyph/layout info here
 *
 * @param {object} [initial]
 * @returns {MemberRecord}
 */
export function createMemberRecord (initial) {
  const record = {
    index: -1,
    matrix: new Matrix4(),
    color: null,
    visible: true,
    uniforms: Object.create(null),
    userData: Object.create(null)
  }
  if (initial) {
    if (initial.matrix) record.matrix.copy(initial.matrix)
    if (initial.color != null) record.color = initial.color
    if (initial.visible != null) record.visible = initial.visible
    if (initial.uniforms) Object.assign(record.uniforms, initial.uniforms)
    if (initial.userData) Object.assign(record.userData, initial.userData)
  }
  return record
}

/**
 * @typedef {Object} MemberRecord
 * @property {number} index
 * @property {import('three').Matrix4} matrix
 * @property {*} color
 * @property {boolean} visible
 * @property {Object<string, *>} uniforms
 * @property {Object} userData
 */
