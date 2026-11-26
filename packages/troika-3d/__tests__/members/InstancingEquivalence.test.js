import {
  Color,
  InstancedMesh,
  Mesh,
  MeshPhongMaterial,
  SphereGeometry,
  Vector3
} from 'three'
import {MemberBatch} from '../../src/facade/members/MemberBatch.js'

const geometry = new SphereGeometry(1)

/**
 * Mirrors the instanceable example's "Use Instancing" toggle: the same 2500 items must land on
 * identical positions/colors whether drawn as one GPU-instanced mesh or as ordinary per-item
 * meshes, because both paths read the same member records.
 */
describe('instanced vs non-instanced equivalence', () => {
  const BOX_SIZE = 1
  const COUNT = 2500

  function buildData () {
    const data = []
    for (let i = 0; i < COUNT; i++) {
      const x = Math.random() * BOX_SIZE
      const y = Math.random() * BOX_SIZE
      const z = Math.random() * BOX_SIZE
      data.push({
        x, y, z,
        color: new Color().setHSL((x + y + z) / BOX_SIZE / 3, 1, 0.5)
      })
    }
    return data
  }

  function populate (batch, data) {
    data.forEach(d => {
      const record = batch.addMember()
      record.matrix.makeTranslation(d.x, d.y, d.z)
      batch.markMemberMatrixDirty(record)
      batch.setMemberUniform(record, 'diffuse', d.color)
    })
  }

  test('all 2500 members keep their position and color across both paths', () => {
    const data = buildData()
    const batch = new MemberBatch({
      geometry,
      material: new MeshPhongMaterial(),
      uniforms: ['diffuse']
    })
    populate(batch, data)

    const instancedMesh = batch.getInstancedMesh()
    expect(instancedMesh).toBeInstanceOf(InstancedMesh)
    expect(instancedMesh.count).toBe(COUNT)

    const fallbackGroup = batch.getFallbackGroup()
    expect(fallbackGroup.children).toHaveLength(COUNT)

    const attr = batch._instancedGeometry._instanceAttrs.uniforms.diffuse
    fallbackGroup.children.forEach((mesh, i) => {
      expect(mesh).toBeInstanceOf(Mesh)

      // World position matches the source data
      const pos = new Vector3().setFromMatrixPosition(mesh.matrixWorld)
      expect(pos.x).toBeCloseTo(data[i].x, 5)
      expect(pos.y).toBeCloseTo(data[i].y, 5)
      expect(pos.z).toBeCloseTo(data[i].z, 5)

      // Per-member color matches the instanced attribute and the source color
      const expected = data[i].color
      expect(attr.getX(i)).toBeCloseTo(expected.r, 4)
      expect(attr.getY(i)).toBeCloseTo(expected.g, 4)
      expect(attr.getZ(i)).toBeCloseTo(expected.b, 4)
      if (mesh.material && mesh.material.color) {
        expect(mesh.material.color.getHex()).toBe(expected.getHex())
      }
    })
  })

  test('toggling paths never mutates the shared base material', () => {
    const baseMaterial = new MeshPhongMaterial()
    const baseHex = baseMaterial.color.getHex()
    const batch = new MemberBatch({
      geometry,
      material: baseMaterial,
      uniforms: ['diffuse']
    })
    const record = batch.addMember()
    batch.setMemberUniform(record, 'diffuse', new Color(0xff00ff))
    batch.getInstancedMesh()
    batch.getFallbackGroup()
    expect(baseMaterial.color.getHex()).toBe(baseHex)
  })
})
