# Unified Member Data and Standalone Rendering

Troika's instanced 3D objects (columns, spheres, UI layers) and its batched 3D text both render
many items in a single draw call. Historically each kept its own per-item data, so the same
logical object described for an instanced mesh could not be handed to a text batch - or drawn
without the Troika scene/world facade - and be guaranteed to land on the same coordinates.

The unified **member data** layer makes one record per renderable item the single source of
truth shared by every rendering path.

## MemberRecord

A member record is a plain object with the same shape whether it backs an instanced mesh or a
batched text label:

| field       | meaning                                                                |
|-------------|------------------------------------------------------------------------|
| `index`     | current packing index within its batch, or `-1` when not packed        |
| `matrix`    | a `THREE.Matrix4` holding the item's **world** transform               |
| `color`     | per-item color (`THREE.Color`, hex, or `null` to inherit the material) |
| `visible`   | whether the item participates in packing/rendering                     |
| `uniforms`  | map of any other per-instance shader uniform values                    |
| `userData`  | free-form slot; batched text keeps glyph/layout state here             |

Create one with the shared factory:

```js
import {createMemberRecord} from 'troika-three-utils'
const record = createMemberRecord()
record.matrix.makeTranslation(1.25, 0.5, -0.75)
```

Because the text batch and the instancing batch read the same record shape, the same translation
handed to both reads back as the identical world coordinates.

## MemberBatch (troika-3d)

A `MemberBatch` owns an ordered list of member records and packs their matrices/colors/uniforms
into GPU instancing attributes. It never touches the scene graph - rendering paths decide how to
consume it.

```js
import {MemberBatch} from 'troika-3d'
import {MeshPhongMaterial, SphereGeometry} from 'three'

const batch = new MemberBatch({
  geometry: new SphereGeometry(1),
  material: new MeshPhongMaterial(),
  uniforms: ['diffuse']
})

const record = batch.addMember()
record.matrix.makeTranslation(1.25, 0.5, -0.75)
batch.markMemberMatrixDirty(record)
batch.setMemberUniform(record, 'diffuse', new Color(0xff0000))
```

### Two rendering paths over the same data

`MemberBatch` can render the exact same members two ways, and both agree on positions and colors:

- **Instanced** - one `THREE.InstancedMesh`, a single draw call:
  ```js
  const mesh = batch.getInstancedMesh()
  scene.add(mesh) // ordinary three object; no Troika world/facade required
  ```
- **Non-instanced** - one ordinary `THREE.Mesh` per member (the "instancing off" path):
  ```js
  const group = batch.getFallbackGroup()
  scene.add(group)
  ```

## SceneMemberRenderer (troika-3d)

For rendering a whole board's worth of batches without starting a scene facade:

```js
import {SceneMemberRenderer} from 'troika-3d'

const view = new SceneMemberRenderer({instanced: true}) // or {instanced: false}
view.setBatches([columnBatch, sphereBatch])
plainThreeScene.add(view.object3D)

// once per frame, after member data may have changed:
view.update()
renderer.render(plainThreeScene, camera)
```

The scene-facade view (batches pushed into a Troika `Scene3DFacade` before rendering) and this
standalone view read the identical records, so splitting one board across both produces the same
columns, spheres and labels.

## Timing

Matrix movement is written synchronously: when an instance moves, its member record and packed
GPU attributes are updated on that same frame and never wait on unrelated work. Text font
loading and line wrapping remain asynchronous; when a text sync completes, the new glyphs appear
together with the already-updated instance positions.
