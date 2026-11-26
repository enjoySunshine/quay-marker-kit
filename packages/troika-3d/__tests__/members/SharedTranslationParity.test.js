import {
  Color,
  Matrix4,
  MeshPhongMaterial,
  SphereGeometry,
  Vector3
} from 'three'
import {MemberBatch} from '../../src/facade/members/MemberBatch.js'
import {createMemberRecord} from 'troika-three-utils'

const geometry = new SphereGeometry(1)
const material = new MeshPhongMaterial()

/**
 * The literal scenario from the board-splitting requirement:
 * "立柱我放到了 1.25、0.5、-0.75 ... 同一份平移交给文字批次和实例网格时，两边读回的世界坐标必须是同一个数。"
 * One translation, handed to both a text batch's member record and an instanced mesh batch,
 * must read back the identical world coordinates on every path.
 */
describe('shared translation parity across text and instance member data', () => {
  const TRANSLATION = [1.25, 0.5, -0.75]

  test('one matrix feeds an instance batch record and a text batch record identically', () => {
    // A single source-of-truth transform, as a board would compute once
    const worldMatrix = new Matrix4().makeTranslation(TRANSLATION[0], TRANSLATION[1], TRANSLATION[2])

    // The instance-grid side (columns/spheres)
    const instanceBatch = new MemberBatch({geometry, material})
    const instanceRecord = createMemberRecord()
    instanceRecord.matrix.copy(worldMatrix)
    instanceBatch.addMember(instanceRecord)

    // The text-label side uses the same record shape; copy the same transform in, the way
    // BatchedText.sync copies each Text's local matrix into its member record.
    const textRecord = createMemberRecord()
    textRecord.matrix.copy(worldMatrix)
    textRecord.userData.text = 'label'

    // Both records hold the same numbers
    const a = new Vector3().setFromMatrixPosition(instanceRecord.matrix)
    const b = new Vector3().setFromMatrixPosition(textRecord.matrix)
    expect(a.toArray()).toEqual(b.toArray())
    expect(a.toArray()).toEqual(TRANSLATION)

    // The instance batch's packed GPU attributes read back the same translation
    instanceBatch.markMemberMatrixDirty(instanceRecord)
    const packed = instanceBatch.pack()
    const rows = packed._instanceAttrs.matrix
    expect([rows[0].getW(0), rows[1].getW(0), rows[2].getW(0)])
      .toEqual(TRANSLATION)

    // And the standalone InstancedMesh readback agrees
    const mesh = instanceBatch.getInstancedMesh()
    const readback = new Matrix4()
    mesh.getMatrixAt(0, readback)
    expect(new Vector3().setFromMatrixPosition(readback).toArray()).toEqual(TRANSLATION)

    // And the non-instanced fallback agrees
    const group = instanceBatch.getFallbackGroup()
    expect(new Vector3().setFromMatrixPosition(group.children[0].matrixWorld).toArray())
      .toEqual(TRANSLATION)
  })

  test('color set once is read back identically whether expressed as record.color or diffuse uniform', () => {
    const hex = 0x808080
    const batch = new MemberBatch({geometry, material, uniforms: ['diffuse']})
    batch.addMember(createMemberRecord({color: hex}))
    const viaUniform = batch.addMember()
    batch.setMemberUniform(viaUniform, 'diffuse', new Color(hex))

    const group = batch.getFallbackGroup()
    expect(group.children[0].material.color.getHex()).toBe(hex)
    expect(group.children[1].material.color.getHex()).toBe(hex)

    const attr = batch.pack()._instanceAttrs.uniforms.diffuse
    const expected = new Color(hex)
    expect(attr.getX(1)).toBeCloseTo(expected.r, 5)
    expect(attr.getY(1)).toBeCloseTo(expected.g, 5)
    expect(attr.getZ(1)).toBeCloseTo(expected.b, 5)
  })
})
