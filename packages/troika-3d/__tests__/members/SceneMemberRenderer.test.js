import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  MeshPhongMaterial,
  SphereGeometry,
  Vector3
} from 'three'
import {MemberBatch} from '../../src/facade/members/MemberBatch.js'
import {SceneMemberRenderer} from '../../src/facade/members/SceneMemberRenderer.js'

const geometry = new SphereGeometry(1)

function populateBatch (batch, positions) {
  positions.forEach(([x, y, z], i) => {
    const record = batch.addMember()
    record.matrix.makeTranslation(x, y, z)
    batch.markMemberMatrixDirty(record)
    if (i % 2 === 0) {
      batch.setMemberUniform(record, 'diffuse', new Color(0x112233))
    }
  })
  return batch
}

describe('SceneMemberRenderer', () => {
  test('renders member batches through an ordinary three Group with no scene facade', () => {
    const batch = populateBatch(new MemberBatch({
      geometry,
      material: new MeshPhongMaterial(),
      uniforms: ['diffuse']
    }), [[1, 2, 3], [4, 5, 6]])

    const view = new SceneMemberRenderer()
    expect(view.object3D).toBeInstanceOf(Group)
    view.setBatches([batch])
    view.update()

    const mesh = view.object3D.children[0]
    expect(mesh).toBeInstanceOf(InstancedMesh)
    expect(mesh.count).toBe(2)
    expect(mesh.$memberBatch).toBe(batch)
  })

  test('the non-instanced view renders one Mesh per member with identical world positions', () => {
    const positions = [[1.25, 0.5, -0.75], [-2, 3.3, 0.1], [0, 0, 0]]
    const batch = populateBatch(new MemberBatch({
      geometry,
      material: new MeshPhongMaterial(),
      uniforms: ['diffuse']
    }), positions)

    const instancedView = new SceneMemberRenderer({instanced: true})
    instancedView.setBatches([batch])
    instancedView.update()
    const instancedMesh = instancedView.object3D.children[0]

    const fallbackView = new SceneMemberRenderer({instanced: false})
    fallbackView.setBatches([batch])
    fallbackView.update()
    const fallbackGroup = fallbackView.object3D.children[0]
    expect(fallbackGroup.children).toHaveLength(3)

    // Both views read the same member data; world positions must agree
    const m = new Matrix4()
    for (let i = 0; i < positions.length; i++) {
      instancedMesh.getMatrixAt(i, m)
      const a = new Vector3().setFromMatrixPosition(m)
      const b = new Vector3().setFromMatrixPosition(fallbackGroup.children[i].matrixWorld)
      expect(a.x).toBeCloseTo(b.x, 5)
      expect(a.y).toBeCloseTo(b.y, 5)
      expect(a.z).toBeCloseTo(b.z, 5)
    }
  })

  test('update() reflects member movement synchronously on the next render object', () => {
    const batch = new MemberBatch({geometry, material: new MeshPhongMaterial()})
    const record = batch.addMember()
    record.matrix.makeTranslation(0, 0, 0)
    const view = new SceneMemberRenderer()
    view.setBatches([batch])
    view.update()

    record.matrix.makeTranslation(7, 8, 9)
    batch.markMemberMatrixDirty(record)
    view.update()

    const mesh = view.object3D.children[0]
    const readback = new Matrix4()
    mesh.getMatrixAt(0, readback)
    const pos = new Vector3().setFromMatrixPosition(readback)
    expect(pos.x).toBeCloseTo(7)
    expect(pos.y).toBeCloseTo(8)
    expect(pos.z).toBeCloseTo(9)
  })

  test('setBatches attaches new batches and detaches removed ones', () => {
    const batchA = populateBatch(new MemberBatch({geometry, material: new MeshPhongMaterial()}), [[1, 0, 0]])
    const batchB = populateBatch(new MemberBatch({geometry, material: new MeshPhongMaterial()}), [[2, 0, 0]])
    const view = new SceneMemberRenderer()
    view.setBatches([batchA, batchB])
    view.update()
    expect(view.object3D.children).toHaveLength(2)

    view.setBatches([batchA])
    view.update()
    expect(view.object3D.children).toHaveLength(1)
    expect(view.object3D.children[0].$memberBatch).toBe(batchA)

    view.clear()
    expect(view.object3D.children).toHaveLength(0)
  })

  test('handles multiple batches including >128 members split across render meshes', () => {
    const big = new MemberBatch({geometry, material: new MeshPhongMaterial()})
    for (let i = 0; i < 300; i++) {
      const r = big.addMember()
      r.matrix.makeTranslation(i, 0, 0)
      big.markMemberMatrixDirty(r)
    }
    const view = new SceneMemberRenderer()
    view.setBatches([big])
    view.update()
    // The standalone InstancedMesh grows to hold all members in one mesh (no 128 cap)
    const mesh = view.object3D.children[0]
    expect(mesh).toBeInstanceOf(InstancedMesh)
    expect(mesh.count).toBe(300)
    const readback = new Matrix4()
    mesh.getMatrixAt(299, readback)
    const lastPos = new Vector3().setFromMatrixPosition(readback)
    expect(lastPos.x).toBeCloseTo(299, 4)
  })
})
