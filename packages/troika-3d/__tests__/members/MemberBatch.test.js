import {
  Color,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshPhongMaterial,
  MeshStandardMaterial,
  SphereGeometry,
  Vector3
} from 'three'
import {MemberBatch} from '../../src/facade/members/MemberBatch.js'

const geometry = new SphereGeometry(1)

function createBatch (config) {
  return new MemberBatch(Object.assign({
    geometry,
    material: new MeshPhongMaterial()
  }, config))
}

describe('MemberBatch member records', () => {
  test('adds members with identity matrices and stable indices', () => {
    const batch = createBatch()
    const a = batch.addMember()
    const b = batch.addMember()
    expect(a.index).toBe(0)
    expect(b.index).toBe(1)
    expect(batch.members).toHaveLength(2)
    expect(a.matrix).toBeInstanceOf(Matrix4)
    expect(a.matrix.elements).toEqual(new Matrix4().elements)
  })

  test('removes by swapping the last record into the removed slot', () => {
    const batch = createBatch()
    const a = batch.addMember()
    const b = batch.addMember()
    const c = batch.addMember()
    batch.removeMember(a)
    expect(batch.members).toHaveLength(2)
    expect(batch.members[0]).toBe(c)
    expect(c.index).toBe(0)
    expect(b.index).toBe(1)
    expect(a.index).toBe(-1)
  })

  test('getMemberAt resolves records by index', () => {
    const batch = createBatch()
    const a = batch.addMember()
    expect(batch.getMemberAt(0)).toBe(a)
  })
})

describe('MemberBatch world matrix readback', () => {
  test('a translation of (1.25, 0.5, -0.75) reads back identically from the packed buffers', () => {
    const batch = createBatch()
    const record = batch.addMember()
    record.matrix.makeTranslation(1.25, 0.5, -0.75)
    batch.markMemberMatrixDirty(record)

    const packed = batch.pack()
    const rows = packed._instanceAttrs.matrix

    // Column-major Matrix4.elements: translation lives at indices 12,13,14 which appear in the
    // fourth component of each of the three row attributes
    expect(rows[0].getW(0)).toBeCloseTo(1.25)
    expect(rows[1].getW(0)).toBeCloseTo(0.5)
    expect(rows[2].getW(0)).toBeCloseTo(-0.75)

    // And from the standalone InstancedMesh path
    const mesh = batch.getInstancedMesh()
    const readback = new Matrix4()
    mesh.getMatrixAt(0, readback)
    const position = new Vector3().setFromMatrixPosition(readback)
    expect(position.x).toBeCloseTo(1.25)
    expect(position.y).toBeCloseTo(0.5)
    expect(position.z).toBeCloseTo(-0.75)

    // And from the non-instanced fallback path - same member data, same world position
    const group = batch.getFallbackGroup()
    const fallbackPos = new Vector3().setFromMatrixPosition(group.children[0].matrixWorld)
    expect(fallbackPos.x).toBeCloseTo(1.25)
    expect(fallbackPos.y).toBeCloseTo(0.5)
    expect(fallbackPos.z).toBeCloseTo(-0.75)
  })

  test('incremental matrix updates change only the moved member without a full repack', () => {
    const batch = createBatch()
    const a = batch.addMember()
    const b = batch.addMember()
    a.matrix.makeTranslation(1, 0, 0)
    b.matrix.makeTranslation(2, 0, 0)
    batch.pack()

    // Move just b
    b.matrix.makeTranslation(2, 9, 0)
    batch.markMemberMatrixDirty(b)
    const packed = batch.pack()
    expect(packed._instanceAttrs.matrix[1].getW(0)).toBeCloseTo(0) // a untouched
    expect(packed._instanceAttrs.matrix[1].getW(1)).toBeCloseTo(9) // b moved
  })

  test('matrix movement is available immediately, independent of any async work', () => {
    // Simulates the requirement that the instanced column is at its new position on the same
    // frame, even while text typesetting (an unrelated async process) has not finished.
    const batch = createBatch()
    const record = batch.addMember()
    record.matrix.makeTranslation(0, 0, 0)
    batch.pack()

    record.matrix.makeTranslation(0, 42, 0)
    batch.markMemberMatrixDirty(record)
    // No flush/await: packing synchronously reflects the new world matrix.
    const mesh = batch.getInstancedMesh()
    const readback = new Matrix4()
    mesh.getMatrixAt(0, readback)
    const pos = new Vector3().setFromMatrixPosition(readback)
    expect(pos.y).toBeCloseTo(42)
  })
})

describe('MemberBatch per-member uniforms and colors', () => {
  test('packs a diffuse color per member and exposes it on both render paths', () => {
    const material = new MeshPhongMaterial()
    const batch = createBatch({material, uniforms: ['diffuse']})
    const a = batch.addMember()
    const b = batch.addMember()
    batch.setMemberUniform(a, 'diffuse', new Color(0xff0000))
    batch.setMemberUniform(b, 'diffuse', new Color(0x00ff00))

    const packed = batch.pack()
    const attr = packed._instanceAttrs.uniforms.diffuse
    expect(attr.getX(0)).toBeCloseTo(1)
    expect(attr.getY(0)).toBeCloseTo(0)
    expect(attr.getZ(0)).toBeCloseTo(0)
    expect(attr.getX(1)).toBeCloseTo(0)
    expect(attr.getY(1)).toBeCloseTo(1)

    // Fallback meshes carry the same colors via cloned materials
    const group = batch.getFallbackGroup()
    expect(group.children[0].material.color.getHex()).toBe(new Color(0xff0000).getHex())
    expect(group.children[1].material.color.getHex()).toBe(new Color(0x00ff00).getHex())
    // The shared base material is never mutated by per-member colors
    expect(material.color.getHex()).toBe(new Color(0xffffff).getHex())
  })

  test('registers uniform names lazily on first use', () => {
    const batch = createBatch()
    const record = batch.addMember()
    expect(batch._uniformNames).toEqual([])
    batch.setMemberUniform(record, 'diffuse', new Color(0xffffff))
    expect(batch._uniformNames).toContain('diffuse')
    expect(batch._uniformSizes.diffuse).toBe(3)
  })

  test('falls back to the material default when a member has no uniform value', () => {
    const material = new MeshPhongMaterial()
    const batch = createBatch({material, uniforms: ['diffuse']})
    const record = batch.addMember()
    const value = batch.getMemberUniform(record, 'diffuse')
    expect(value.getHex()).toBe(material.color.getHex())
  })
})

describe('MemberBatch visibility and counts', () => {
  test('invisible members are excluded from the packed count', () => {
    const batch = createBatch()
    const a = batch.addMember()
    const b = batch.addMember()
    b.visible = false
    const packed = batch.pack()
    expect(batch.memberCount).toBe(1)
    expect(getGeomInstanceCount(packed)).toBe(1)
    expect(packed._instanceAttrs.matrix[0].getW(0)).toBe(a.matrix.elements[12])
  })

  test('grows buffers when member count exceeds capacity', () => {
    const batch = createBatch()
    for (let i = 0; i < 5; i++) {
      const r = batch.addMember()
      r.matrix.makeTranslation(i, 0, 0)
    }
    const packed = batch.pack()
    expect(packed._capacity).toBeGreaterThanOrEqual(5)
    expect(getGeomInstanceCount(packed)).toBe(5)
  })
})

describe('MemberBatch standalone render objects', () => {
  test('getInstancedMesh returns a real InstancedMesh rendering without any scene facade', () => {
    const batch = createBatch()
    const record = batch.addMember()
    record.matrix.makeTranslation(3, 4, 5)
    const mesh = batch.getInstancedMesh()
    expect(mesh).toBeInstanceOf(InstancedMesh)
    expect(mesh.$memberBatch).toBe(batch)
    expect(mesh.count).toBe(1)
    expect(mesh.frustumCulled).toBe(false)
    // It is an ordinary three object: no troika world needed to add it to a scene
    const sceneGroup = new Group()
    sceneGroup.add(mesh)
    expect(sceneGroup.children).toContain(mesh)
  })

  test('getFallbackGroup returns one ordinary Mesh per member with matching transforms', () => {
    const batch = createBatch()
    for (let i = 0; i < 3; i++) {
      const r = batch.addMember()
      r.matrix.makeTranslation(i, i * 2, i * 3)
    }
    const group = batch.getFallbackGroup()
    expect(group).toBeInstanceOf(Group)
    expect(group.children).toHaveLength(3)
    group.children.forEach((mesh, i) => {
      expect(mesh).toBeInstanceOf(Mesh)
      const pos = new Vector3().setFromMatrixPosition(mesh.matrixWorld)
      expect(pos.x).toBeCloseTo(i)
      expect(pos.y).toBeCloseTo(i * 2)
      expect(pos.z).toBeCloseTo(i * 3)
    })
  })

  test('instanced and fallback paths produce identical world positions', () => {
    const batch = createBatch()
    const positions = [[1.25, 0.5, -0.75], [-2, 3.3, 0.1], [0, 0, 0]]
    positions.forEach(([x, y, z]) => {
      const r = batch.addMember()
      r.matrix.makeTranslation(x, y, z)
    })
    const mesh = batch.getInstancedMesh()
    const group = batch.getFallbackGroup()
    const m = new Matrix4()
    for (let i = 0; i < positions.length; i++) {
      mesh.getMatrixAt(i, m)
      const instancedPos = new Vector3().setFromMatrixPosition(m)
      const fallbackPos = new Vector3().setFromMatrixPosition(group.children[i].matrixWorld)
      // The instanced path stores into Float32 attributes, so compare with float tolerance
      expect(instancedPos.x).toBeCloseTo(fallbackPos.x, 5)
      expect(instancedPos.y).toBeCloseTo(fallbackPos.y, 5)
      expect(instancedPos.z).toBeCloseTo(fallbackPos.z, 5)
    }
  })

  test('works with a MeshStandardMaterial so normal-based lighting stays intact', () => {
    const standard = new MeshStandardMaterial({roughness: 0.5, metalness: 0.5})
    const batch = new MemberBatch({geometry, material: standard})
    batch.addMember()
    const mesh = batch.getInstancedMesh()
    // The derived material keeps the standard lighting shader; instancing only injects the
    // matrix/normal-matrix handling.
    expect(mesh.material.baseMaterial).toBe(standard)
    expect(mesh.material.isTroikaTextMaterial).toBeFalsy()
  })
})

describe('MemberBatch disposal', () => {
  test('dispose releases render objects but keeps member data', () => {
    const batch = createBatch()
    const record = batch.addMember()
    record.matrix.makeTranslation(1, 2, 3)
    batch.getInstancedMesh()
    batch.getFallbackGroup()
    batch.dispose()
    expect(batch._instancedMesh).toBeNull()
    expect(batch._instancedGeometry).toBeNull()
    expect(batch.members).toHaveLength(1)
    // Can rebuild after disposal
    const mesh = batch.getInstancedMesh()
    expect(mesh).toBeInstanceOf(InstancedMesh)
  })
})

function getGeomInstanceCount (geom) {
  return geom[geom.hasOwnProperty('instanceCount') ? 'instanceCount' : 'maxInstancedCount']
}
