import {Matrix4, Color} from 'three'
import {createMemberRecord} from '../src/memberRecord.js'

describe('createMemberRecord', () => {
  test('creates a record with the shared default shape', () => {
    const record = createMemberRecord()
    expect(record.index).toBe(-1)
    expect(record.matrix).toBeInstanceOf(Matrix4)
    expect(record.matrix.elements).toEqual(new Matrix4().elements)
    expect(record.color).toBeNull()
    expect(record.visible).toBe(true)
    expect(record.uniforms).toEqual({})
    expect(record.userData).toEqual({})
  })

  test('copies initial values without sharing nested object references', () => {
    const matrix = new Matrix4().makeTranslation(1.25, 0.5, -0.75)
    const record = createMemberRecord({
      matrix,
      color: 0xff0000,
      visible: false,
      uniforms: {diffuse: new Color(0x00ff00)},
      userData: {glyphCount: 7}
    })
    expect(record.matrix).not.toBe(matrix)
    expect(record.matrix.elements).toEqual(matrix.elements)
    expect(record.color).toBe(0xff0000)
    expect(record.visible).toBe(false)
    expect(record.uniforms.diffuse.getHex()).toBe(new Color(0x00ff00).getHex())
    expect(record.userData.glyphCount).toBe(7)
  })

  test('records are independent instances', () => {
    const a = createMemberRecord()
    const b = createMemberRecord()
    a.matrix.makeTranslation(1, 0, 0)
    expect(b.matrix.elements).toEqual(new Matrix4().elements)
    a.uniforms.radius = 2
    expect(b.uniforms.radius).toBeUndefined()
  })
})
