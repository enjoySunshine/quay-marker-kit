import { Group } from 'three'

/**
 * A SceneMemberRenderer renders one or more {@link MemberBatch}s as ordinary Three.js objects,
 * with no Troika world or scene facade involved. It is the "no scene facade" half of splitting a
 * board into two identical views:
 *
 *   - the scene-facade view pushes batches into a Troika scene before rendering;
 *   - this view hands the same member data to plain THREE meshes in an ordinary scene.
 *
 * Because both views read the identical member records, the columns, spheres and labels land on
 * the same world coordinates with the same colors. The renderer supports both the instanced path
 * (one batched mesh per MemberBatch, a single draw call each) and a non-instanced fallback (one
 * ordinary Mesh per member) whose positions/colors are guaranteed to match.
 *
 * Usage:
 *
 *     const renderer3d = new WebGLRenderer()
 *     const scene = new THREE.Scene()
 *     const view = new SceneMemberRenderer({instanced: true})
 *     view.setBatches([columnBatch, sphereBatch, labelBatch])
 *     scene.add(view.object3D)
 *     // whenever member data changes:
 *     view.update()
 *     renderer3d.render(scene, camera)
 */
class SceneMemberRenderer {
  /**
   * @param {object} [config]
   * @param {boolean} [config.instanced=true] - use GPU instancing (MemberBatch.getInstancedMesh)
   *   when true, otherwise one ordinary Mesh per member (MemberBatch.getFallbackGroup).
   */
  constructor (config = {}) {
    this.instanced = config.instanced !== false

    /**
     * The root object to add to a plain THREE.Scene.
     * @type {THREE.Group}
     */
    this.object3D = new Group()

    this._batches = []
    this._renderObjects = new Map() // MemberBatch -> InstancedMesh | Group
  }

  /**
   * Set the member batches this view renders. Previously rendered batches not present in the
   * new list are removed and their render objects detached (member data itself is untouched).
   * @param {MemberBatch[]} batches
   */
  setBatches (batches) {
    this._batches = (batches || []).slice()
    const next = new Set(this._batches)

    // Detach render objects for batches that are no longer rendered
    this._renderObjects.forEach((obj, batch) => {
      if (!next.has(batch)) {
        this.object3D.remove(obj)
        this._renderObjects.delete(batch)
      }
    })
  }

  /**
   * Sync every batch's member data into its render objects and attach any new ones. Call this
   * once per frame before `renderer.render()`. Matrix changes are written synchronously here, so
   * instanced items are already at their new world positions even when unrelated work (e.g. text
   * typesetting) is still in progress.
   */
  update () {
    for (let i = 0; i < this._batches.length; i++) {
      const batch = this._batches[i]
      let obj = this._renderObjects.get(batch)
      const nextObj = this.instanced ? batch.getInstancedMesh() : batch.getFallbackGroup()
      if (obj !== nextObj) {
        if (obj) this.object3D.remove(obj)
        this.object3D.add(nextObj)
        this._renderObjects.set(batch, nextObj)
        obj = nextObj
      }
      // The getters already run pack()/sync, but make sure visibility is current
      obj.visible = true
    }
  }

  /**
   * Remove all render objects. Member batches and their records are retained.
   */
  clear () {
    this._renderObjects.forEach(obj => this.object3D.remove(obj))
    this._renderObjects.clear()
  }
}

export { SceneMemberRenderer }
