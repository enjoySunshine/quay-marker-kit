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

/**
 * Requirement: while text is still typesetting, instanced items must already be positioned at
 * their new world coordinates; the two update paths must not block one another. When the text
 * sync finally completes, both appear together on that frame.
 */
describe('member data timing independence', () => {
  test('matrix movement is applied synchronously with no awaited/async gate', async () => {
    const batch = new MemberBatch({geometry, material: new MeshPhongMaterial()})
    const column = batch.addMember()

    // Frame 1: initial position
    column.matrix.makeTranslation(0, 0, 0)
    batch.markMemberMatrixDirty(column)
    let mesh = batch.getInstancedMesh()
    let p = new Vector3().setFromMatrixPosition(readMatrix(mesh, 0))
    expect(p.toArray()).toEqual([0, 0, 0])

    // Simulate an in-flight text sync: a promise that has NOT resolved yet. Moving the column
    // must not depend on it.
    let resolveTextSync
    const pendingTextSync = new Promise(resolve => { resolveTextSync = resolve })
    await expectPending(pendingTextSync)

    // Move the column immediately - purely synchronous member-data bookkeeping
    column.matrix.makeTranslation(1.25, 0.5, -0.75)
    batch.markMemberMatrixDirty(column)

    // Before the text sync resolves, the packed render object already carries the new matrix
    mesh = batch.getInstancedMesh()
    p = new Vector3().setFromMatrixPosition(readMatrix(mesh, 0))
    expect(p.x).toBeCloseTo(1.25)
    expect(p.y).toBeCloseTo(0.5)
    expect(p.z).toBeCloseTo(-0.75)

    // Now the text sync completes; nothing about the column matrix needed to wait for it
    resolveTextSync()
    await pendingTextSync
    const stillThere = new Vector3().setFromMatrixPosition(readMatrix(mesh, 0))
    expect(stillThere.x).toBeCloseTo(1.25)
  })

  test('a shared member record can carry both an instanced transform and text layout userData', () => {
    // This is the bridge that lets one board's labels and columns be described by one record set
    const record = createMemberRecord()
    record.matrix.makeTranslation(3, 4, 5)
    record.color = new Color(0x808080)
    record.userData.text = 'One'
    record.userData.curveRadius = 0
    record.userData.strokeWidth = 0
    record.userData.clipRect = [0, 0, 2, 1]

    const batch = new MemberBatch({geometry, material: new MeshPhongMaterial()})
    batch.addMember(record)
    const mesh = batch.getInstancedMesh()
    const pos = new Vector3().setFromMatrixPosition(readMatrix(mesh, 0))
    expect(pos.toArray()).toEqual([3, 4, 5])
    // Text-specific fields ride along untouched for the text rendering path
    expect(record.userData.text).toBe('One')
    expect(record.userData.clipRect).toEqual([0, 0, 2, 1])
  })
})

function readMatrix (instancedMesh, index) {
  const m = new Matrix4()
  instancedMesh.getMatrixAt(index, m)
  return m
}

// Yield a microtask so a pending promise is guaranteed not to have resolved synchronously
async function expectPending (promise) {
  const marker = {}
  const result = await Promise.race([
    promise.then(() => 'resolved'),
    Promise.resolve(marker)
  ])
  expect(result).toBe(marker)
}
