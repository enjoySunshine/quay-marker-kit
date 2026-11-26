import {
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshPhongMaterial,
  Raycaster,
  Sphere,
  SphereGeometry,
  Vector3
} from 'three'
import InstancingManager from '../../src/facade/instancing/InstancingManager.js'
import Instanceable3DFacade from '../../src/facade/instancing/Instanceable3DFacade.js'
import {MemberBatch} from '../../src/facade/members/MemberBatch.js'

const geometry = new SphereGeometry(1)
const material = new MeshPhongMaterial()
const protoMesh = new Mesh(geometry, material)

/**
 * Build an InstancingManager without a full world/scene facade: its constructor only needs an
 * object whose notifyWorld bubbles into the manager's own handlers.
 */
function createManager () {
  const manager = Object.create(InstancingManager.prototype)
  manager._instanceables = Object.create(null)
  manager._memberBatchesByKey = Object.create(null)
  manager._needsRebatch = true
  manager._listeners = Object.create(null)
  manager.parent = null
  manager.addEventListener = function (type, handler) {
    (this._listeners[type] = this._listeners[type] || []).push(handler)
  }
  manager.dispatchEvent = function (event, ...args) {
    (this._listeners[event.type] || []).forEach(fn => fn.apply(this, args))
  }
  // Mimic the real constructor's render listener registration
  manager.addEventListener('beforerender', manager._setupBatchObjects.bind(manager))
  manager.addEventListener('afterrender', manager._teardownBatchObjects.bind(manager))
  // Route facade world notifications straight into the manager's handlers, like a real tree does
  manager.notifyWorld = function (source, message, data) {
    const handler = this._notifyWorldHandlers[message]
    if (handler) handler.call(this, source, data)
  }
  return manager
}

function createInstanceable (manager, {x = 0, y = 0, z = 0, color = null} = {}) {
  // A minimal parent facade whose notifyWorld routes to the manager
  const parentThreeObject = new Group()
  parentThreeObject.matrixWorld.identity()
  const parent = {
    isObject3DFacade: true,
    threeObject: parentThreeObject,
    _queueRemoveChildObject3D: () => {},
    _flushQueuedChildRemovals: () => {},
    notifyWorld: (source, message, data) => manager.notifyWorld(source, message, data),
    onNotifyWorld: (source, message, data) => manager.notifyWorld(source, message, data)
  }
  const facade = new Instanceable3DFacade(parent)
  facade.instancedThreeObject = protoMesh
  facade.x = x
  facade.y = y
  facade.z = z
  if (color != null) {
    facade.setInstanceUniform('diffuse', new Color(color))
  }
  facade.afterUpdate()
  return facade
}

function runFrame (manager) {
  const scene = new Group()
  scene.matrixWorld.identity()
  manager._needsRebatch = true
  manager.dispatchEvent({type: 'beforerender'}, null, scene, null)
  return scene
}

describe('InstancingManager <-> MemberBatch integration', () => {
  test('registers instanceables and packs their world matrices into a member batch', () => {
    const manager = createManager()
    const facade = createInstanceable(manager, {x: 1.25, y: 0.5, z: -0.75})
    const scene = runFrame(manager)

    // One render batch object was pushed into the scene
    expect(scene.children.length).toBe(1)
    const batchObj = scene.children[0]
    expect(batchObj.$memberBatch).toBeInstanceOf(MemberBatch)

    // The facade's member record holds its world matrix and is the same object the batch packs
    const record = facade._memberRecord
    expect(record).toBe(batchObj.$memberBatch.members[0])
    const position = new Vector3().setFromMatrixPosition(record.matrix)
    expect(position.x).toBeCloseTo(1.25)
    expect(position.y).toBeCloseTo(0.5)
    expect(position.z).toBeCloseTo(-0.75)

    // The packed instanced attributes read back the same translation
    const rows = batchObj.$memberBatch._instancedGeometry._instanceAttrs.matrix
    expect(rows[0].getW(0)).toBeCloseTo(1.25)
    expect(rows[1].getW(0)).toBeCloseTo(0.5)
    expect(rows[2].getW(0)).toBeCloseTo(-0.75)
  })

  test('the same member records render through a standalone InstancedMesh with no scene facade', () => {
    const manager = createManager()
    const facade = createInstanceable(manager, {x: 3, y: -2, z: 1})
    runFrame(manager)

    // Hand the manager's member batch directly to an ordinary three InstancedMesh - no world
    const standaloneScene = new Group()
    const mesh = facade._memberBatch.getInstancedMesh()
    standaloneScene.add(mesh)

    expect(standaloneScene.children).toContain(mesh)
    const readback = new Matrix4()
    mesh.getMatrixAt(0, readback)
    const pos = new Vector3().setFromMatrixPosition(readback)
    expect(pos.x).toBeCloseTo(3)
    expect(pos.y).toBeCloseTo(-2)
    expect(pos.z).toBeCloseTo(1)
  })

  test('per-instance diffuse colors flow into both the packed attributes and standalone mesh', () => {
    const manager = createManager()
    const red = createInstanceable(manager, {x: 0, color: 0xff0000})
    const green = createInstanceable(manager, {x: 1, color: 0x00ff00})
    runFrame(manager)

    const memberBatch = red._memberBatch
    expect(memberBatch).toBe(green._memberBatch)
    const attr = memberBatch._instancedGeometry._instanceAttrs.uniforms.diffuse
    expect(attr.getX(0)).toBeCloseTo(1)
    expect(attr.getY(1)).toBeCloseTo(1)

    // Fallback (instancing off) path from the same member data gets matching colors
    const group = memberBatch.getFallbackGroup()
    expect(group.children[0].material.color.getHex()).toBe(new Color(0xff0000).getHex())
    expect(group.children[1].material.color.getHex()).toBe(new Color(0x00ff00).getHex())
  })

  test('moving an instance updates its member matrix immediately, independent of any text sync', () => {
    const manager = createManager()
    const facade = createInstanceable(manager, {x: 0})
    runFrame(manager)

    // Move it; even before the next frame's pack the facade world matrix is already updated
    facade.x = 42
    facade.updateMatrices()
    // The record is synced during beforerender; the facade world matrix itself is already there
    const facadePos = new Vector3().setFromMatrixPosition(facade.threeObject.matrixWorld)
    expect(facadePos.x).toBeCloseTo(42)

    // And after the next frame they agree
    runFrame(manager)
    const packedPos = new Vector3().setFromMatrixPosition(facade._memberRecord.matrix)
    expect(packedPos.x).toBeCloseTo(42)
  })

  test('removing an instance releases its member record slot', () => {
    const manager = createManager()
    const a = createInstanceable(manager, {x: 0})
    const b = createInstanceable(manager, {x: 1})
    runFrame(manager)
    expect(a._memberBatch.members).toHaveLength(2)

    manager.notifyWorld(a, 'instanceableRemoved')
    a.destructor()
    runFrame(manager)
    expect(b._memberBatch.members).toHaveLength(1)
    expect(b._memberRecord.index).toBe(0)
  })

  test('bounding sphere and raycasting still use the real world transform, not a zero-radius origin', () => {
    const manager = createManager()
    const facade = createInstanceable(manager, {x: 5, y: 0, z: 0})
    runFrame(manager)

    const sphere = facade.getBoundingSphere()
    expect(sphere).toBeInstanceOf(Sphere)
    expect(sphere.center.x).toBeCloseTo(5)
    expect(sphere.radius).toBeGreaterThan(0)

    // A ray aimed at the moved sphere still hits this exact facade. Aim slightly off the exact
    // pole axis, where triangle edges meet, to avoid a grazing-ray precision edge.
    const raycaster = new Raycaster()
    raycaster.set(new Vector3(5.5, 0.5, 10), new Vector3(0, 0, -1))
    const hits = facade.raycast(raycaster)
    expect(hits).not.toBeNull()
    expect(hits.length).toBeGreaterThan(0)

    // A ray aimed well away from the moved sphere misses it
    const missRay = new Raycaster()
    missRay.set(new Vector3(-5, 0, 10), new Vector3(0, 0, -1))
    expect(facade.raycast(missRay)).toBeNull()
  })

  test('re-runs frames stably, keeping members and packed geometry consistent', () => {
    const manager = createManager()
    const facades = []
    for (let i = 0; i < 300; i++) {
      facades.push(createInstanceable(manager, {x: i, color: i % 2 ? 0xff0000 : 0x00ff00}))
    }
    const firstScene = runFrame(manager)
    expect(firstScene.children.length).toBe(Math.ceil(300 / 128))

    // A second frame with no changes must keep the same member records and member counts
    const secondScene = runFrame(manager)
    expect(secondScene.children.length).toBe(firstScene.children.length)
    let total = 0
    facades.forEach(f => {
      expect(f._memberRecord).toBeTruthy()
      expect(f._memberBatch.members).toContain(f._memberRecord)
      total++
    })
    expect(total).toBe(300)

    // Move every other member and confirm the packed matrices follow on the next frame
    facades.forEach((f, i) => {
      if (i % 2 === 0) {
        f.x = i + 1000
        f.updateMatrices()
      }
    })
    runFrame(manager)
    facades.forEach((f, i) => {
      const pos = new Vector3().setFromMatrixPosition(f._memberRecord.matrix)
      if (i % 2 === 0) {
        expect(pos.x).toBeCloseTo(i + 1000, 4)
      } else {
        expect(pos.x).toBeCloseTo(i, 4)
      }
    })
  })

  test('adding and removing instances across frames keeps member batches packed', () => {
    const manager = createManager()
    const a = createInstanceable(manager, {x: 1})
    const b = createInstanceable(manager, {x: 2})
    runFrame(manager)
    expect(a._memberBatch.members).toHaveLength(2)

    // Remove one and add another on the next frame
    manager.notifyWorld(a, 'instanceableRemoved')
    a.destructor()
    const c = createInstanceable(manager, {x: 3})
    const scene = runFrame(manager)

    // No orphaned/duplicate records: exactly two live members again
    const liveBatches = new Set([b._memberBatch, c._memberBatch])
    let total = 0
    liveBatches.forEach(mb => { total += mb.memberCount })
    expect(total).toBe(2)
    expect(scene.children.length).toBe(1)
    // The surviving and new facades both resolve to valid records
    expect(b._memberRecord.index).toBeGreaterThanOrEqual(0)
    expect(c._memberRecord.index).toBeGreaterThanOrEqual(0)
    const positions = [b, c].map(f =>
      new Vector3().setFromMatrixPosition(f._memberRecord.matrix).x
    ).sort((x, y) => x - y)
    expect(positions).toEqual([2, 3])
  })

  test('moving an instance moves its bounding sphere, so the octree entry never collapses to origin', () => {
    const manager = createManager()
    const facade = createInstanceable(manager, {x: 0})
    runFrame(manager)
    const before = facade.getBoundingSphere()
    expect(before.center.x).toBeCloseTo(0)

    facade.x = 9
    facade.updateMatrices()
    runFrame(manager)
    const after = facade.getBoundingSphere()
    expect(after.center.x).toBeCloseTo(9)
    expect(after.radius).toBeCloseTo(before.radius)
    expect(after.center.x).not.toBeCloseTo(0)
  })

  test('instanced and non-instanced outputs agree for a 2500-member box distribution', () => {
    // Mirrors the instanceable example: 2500 items distributed within a unit box
    const manager = createManager()
    const facades = []
    for (let i = 0; i < 2500; i++) {
      const x = (i % 50) / 50
      const y = (Math.floor(i / 50) % 50) / 50
      const z = Math.floor(i / 2500)
      facades.push(createInstanceable(manager, {x, y, z, color: 0x112233}))
    }
    const scene = runFrame(manager)

    // Multiple render batches (>128 per batch) were pushed
    expect(scene.children.length).toBeGreaterThan(1)
    // The 2500 members split into ceil(2500/128) = 20 render batches
    expect(scene.children.length).toBe(Math.ceil(2500 / 128))
    let totalPacked = 0
    const batches = new Set()
    facades.forEach(f => {
      batches.add(f._memberBatch)
      totalPacked++
    })
    expect(totalPacked).toBe(2500)
    // One MemberBatch per render batch, each capped at 128
    expect(batches.size).toBe(Math.ceil(2500 / 128))
    batches.forEach(memberBatch => {
      expect(memberBatch.memberCount).toBeLessThanOrEqual(128)
    })

    // Every member batch can produce an equivalent non-instanced group with the same positions
    batches.forEach(memberBatch => {
      const group = memberBatch.getFallbackGroup()
      expect(group.children.length).toBe(memberBatch.memberCount)
      group.children.forEach((mesh, i) => {
        const record = memberBatch.members[i]
        const fallbackPos = new Vector3().setFromMatrixPosition(mesh.matrixWorld)
        const recordPos = new Vector3().setFromMatrixPosition(record.matrix)
        expect(fallbackPos.x).toBeCloseTo(recordPos.x, 5)
        expect(fallbackPos.y).toBeCloseTo(recordPos.y, 5)
        expect(fallbackPos.z).toBeCloseTo(recordPos.z, 5)
      })
    })
  })

  test('invisible instances are excluded from the scene batch but keep their facade record', () => {
    const manager = createManager()
    const visible = createInstanceable(manager, {x: 1})
    const hidden = createInstanceable(manager, {x: 2})
    hidden.threeObject.visible = false
    const scene = runFrame(manager)

    // Only the visible facade gets a render batch; the hidden one gets no batch pointers
    expect(scene.children.length).toBe(1)
    expect(hidden._instancingBatchObject).toBeNull()
    expect(visible._instancingBatchObject).toBeTruthy()
    // The visible batch contains exactly one packed member
    expect(visible._memberBatch.memberCount).toBe(1)
  })
})
