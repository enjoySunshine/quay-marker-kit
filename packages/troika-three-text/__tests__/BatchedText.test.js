import {Matrix4} from 'three'
import {Text, BatchedText} from '../src/index.js'

describe('BatchedText shared member records', () => {
  test('exposes each added text as a shared-shaped member record', () => {
    const batch = new BatchedText()
    const text = new Text()
    batch.addText(text)

    const record = batch._members.get(text)
    expect(record).toBeDefined()
    // Same shape as the instancing MemberBatch records
    expect(record.index).toBe(-1)
    expect(record.matrix).toBeInstanceOf(Matrix4)
    expect(record).toHaveProperty('color')
    expect(record.visible).toBe(true)
    expect(record.uniforms).toEqual({})
    expect(record.userData).toBeDefined()
    // Text-specific packing state lives in userData
    expect(record.userData.dirty).toBe(true)
    expect(record.userData.glyphCount).toBe(-1)
  })

  test('marks a member record dirty when that text finishes syncing', () => {
    const batch = new BatchedText()
    const text = new Text()
    batch.addText(text)
    const record = batch._members.get(text)
    record.userData.dirty = false
    text.dispatchEvent({type: 'synccomplete'})
    expect(record.userData.dirty).toBe(true)
  })

  test('removes the member record and flags a repack', () => {
    const batch = new BatchedText()
    const text = new Text()
    batch.addText(text)
    batch.removeText(text)
    expect(batch._members.has(text)).toBe(false)
    expect(batch._needsRepack).toBe(true)
  })

  test('add()/remove() route Text instances through the member map', () => {
    const batch = new BatchedText()
    const text = new Text()
    batch.add(text)
    expect(batch._members.has(text)).toBe(true)
    batch.remove(text)
    expect(batch._members.has(text)).toBe(false)
  })

  test('member records stay stable across add/remove cycles', () => {
    const batch = new BatchedText()
    const a = new Text()
    const b = new Text()
    batch.addText(a)
    batch.addText(b)
    const recordA = batch._members.get(a)
    batch.removeText(a)
    batch.addText(a)
    // Re-adding creates a fresh record rather than resurrecting stale state
    expect(batch._members.get(a)).not.toBe(recordA)
    expect(batch._members.has(b)).toBe(true)
  })

  test('hasOutline reflects any member with an outline configuration', () => {
    const batch = new BatchedText()
    const a = new Text()
    const b = new Text()
    batch.addText(a)
    batch.addText(b)
    expect(batch.hasOutline()).toBe(false)
    a.outlineWidth = 0.02
    expect(batch.hasOutline()).toBe(true)
  })
})
