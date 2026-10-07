# Block pack export

Status: **implemented.** `rendermite blocks` / `exportBlockPack()`. Source in `src/blocks/`,
tests in `test/block-pack.test.ts`, `test/blockstate-eval.test.ts` and `test/atlas-pack.test.ts`.

rendermite renders finished item icons. This is a second output mode that emits **block geometry
and textures as data**, for a renderer that draws blocks itself, such as an in-browser world viewer
or editor that reads Anvil regions and puts chunks on screen in 3D.

## Why this belongs in rendermite

The rasterizer is useless to that consumer: it draws 64px PNGs on the CPU, and a chunk renderer
needs a GPU and per-frame geometry. But **everything above the rasterizer is exactly what it needs**,
and that layer is the part that takes months to get right — jar layering, parent-chain flattening,
`#texture` resolution, atlas sources, per-era shims, and the long tail of mod formats described in
`docs/mod-coverage.md`.

Rebuilding that in a browser would mean reimplementing this repo badly. Exporting from here means
the browser gets a flat, pre-resolved data pack and the asset knowledge stays in one place.

## Usage

```
rendermite blocks --version 1.21.8 --output blocks/1.21.8
rendermite blocks --version 1.20.4 --mod create.jar --mod immersiveengineering.jar --output blocks/modded
```

A modded run without `--namespace` exports the mods' own namespaces rather than vanilla again.
The library entry point is `exportBlockPack({ resources, output, version, namespaces })`.

## Scope

**In:** Java Edition block models and textures, vanilla and modded, **1.13 and up**, one version at a
time. Output is a texture atlas plus JSON describing baked geometry, blockstate → model mapping, and
tint semantics.

**Out:** anything that draws the blocks. No meshing, no chunk decoding, no three.js. The consumer
owns all of that. Also out: entity models, item models (already covered by the icon pipeline), and
Bedrock.

## Version support: 1.13 and up

**The floor is 1.13 — the Flattening.** From 17w47a a chunk section's palette stores namespaced ids
(`minecraft:oak_stairs` plus a property map) instead of a numeric id and a metadata nibble. That is
the line the consumer draws: a world it can address by name is one this pack can describe. Below it
a block is `35:14` and mapping that to a model needs a hand-maintained ~1,500-entry table, which is
a separate project and explicitly out of scope. The CLI refuses anything lower rather than emitting
a pack that cannot be addressed.

1.13+ sits **entirely inside rendermite's `models` (1.9–1.21.3) and `modern` (1.21.4+) eras**, so
none of the pre-1.8 machinery applies and the exporter is not version-gated anywhere.
`prepareVersionResources` layers the jar and little else.

Things that *do* vary across 1.13 → current, and that the exporter is right about:

- **`atlases/` only exists from 1.19.3.** Below that `loadAtlasResolver` finds no atlas files and
  returns a resolver that resolves nothing — and that is **correct**, not a bug to fix. Those
  versions have no synthesized sprites, so every texture resolves by direct file lookup through
  `TextureLoader`. Resist "fixing" the empty resolver.
- **`multipart` exists from 1.9**, so both blockstate forms are present across the whole range.
- **Colormaps grew.** `grass.png` and `foliage.png` throughout; `dry_foliage.png` only in recent
  versions. `buildBlockTints` probes for each rather than assuming three.
- **`render_type` is a loader extension** that vanilla only adopted recently, so alpha inference is
  the mechanism across the entire supported range.

## What it reuses

None of this needed changing beyond two small additive fixes (below). `ItemPipeline.create` is the
reference for the construction order, especially `setAtlasResolver` after building the
`TextureLoader`.

| Need | Used |
| --- | --- |
| Get a version's assets | `prepareVersionResources({ version, jar })` |
| Add mod jars | `prepareModResources({ jars, vanilla })` |
| Flatten a model | `new ModelLoader(resources).load(locator)` → `ResolvedModel` |
| Turn `#north` into a file | `resolveTexture(model, reference)` |
| Decode a texture | `new TextureLoader(resources).load(locator)` |
| Animation frames | `textures.loadAnimated(locator)` → `.frameStartTicks()`, `.frame(i)`, `.tickLength` |
| Synthesized sprites | `loadAtlasResolver` from `src/atlas/registry.ts`, then `textures.setAtlasResolver(…)` |

Two changes landed outside `src/blocks/` and both benefit the icon path too:

- **`ResolvedModel.ambientOcclusion`** — `ambientocclusion` merged down the parent chain. The pack
  needs it per model and re-walking the chain to read one boolean would be worse.
- **`resolveTexture` treats a bare face texture as a variable name.** The game strips the `#` and
  looks the value up in the texture map either way, so the sigil is decorative — vanilla's own
  `block/heavy_core` writes `"texture": "all"`. Before this, heavy core exported with no faces at
  all. A bare name matching no variable is still treated as a direct locator, as before.

## Output contract

```
<output>/
  atlas-0.png          stitched page(s), 4px edge-extended padding
  atlas.json           sprite id -> rect, render layer, animation frames
  models.json          model id  -> { ao, elements: [...], mesh?, renderType?, multiblock? }
  blockstates.json     block id  -> { variants | multipart }, keys and predicates pre-parsed
  tints.json           flat plains colours, colormaps, ramps, per-block semantics
  biomes.json          biome id -> climate and the colours it overrides (absent when there are none)
  light.json           block id -> light emitted, per state where it varies (absent when nothing emits; block-light.md)
  behaviour.json       block id -> hardness, collision, replaceable, map colour… from the code (absent without it)
  states.json          block id -> every property, values in order, and the default state (only with --reports)
  tags.json            registry -> tag id -> values, unexpanded, from the jar's own datapack
  advancements.json    advancement id -> criteria names, recipe unlocks left out
  game-rules.json      rule name -> { type, default }, from the code (vanilla packs only)
  names.json           block and item id -> English display name, from each namespace's en_us
  colormap/*.png       the version's own grass/foliage/dry_foliage maps
  items.json           item id  -> flat layer sprites, with its own atlas (absent when there are none)
  item-atlas-N.png     the item sheet's own page(s), addressed by items.json
  entities.json        entity id -> display name, marker colour, sheet, model (absent when none)
  entity-models.json   model id  -> bone hierarchy of boxes, with its own atlas (entity-geometry.md)
  entity-atlas-N.png   the entity sheets those models address
  failures.json        every block, model, sprite, tintindex and item the run could not fully handle
  meta.json            version, counts, sha256 of every other file
```

Everything is pre-resolved: face textures are sprite ids, UVs are always present (derived per
vanilla's `BlockElement.uvsByFace` when the model omits one), and variant keys and multipart
predicates are structures rather than strings. The consumer should never need to resolve anything.

**`blockstates.json`.** `variants` is an array of `{ when, apply }` rather than a map, so the key
parsing is already done and ordering is preserved. `multipart` predicates are a tree:

```json
{ "op": "match",  "properties": { "north": ["true"], "shape": ["north_west", "north_east"] } }
{ "op": "or",     "terms": [ … ] }
{ "op": "and",    "terms": [ … ] }
```

An unconditional part has `"when": null`. `apply` is always an array — the weighted list, whole,
minus any `weight: 0` entry the game could never pick — and `x`, `y`, `z`, `uvlock` and `weight` are
omitted at their defaults (`0`, `0`, `0`, `false`, `1`).
`z` is a loader extension rather than vanilla: AE2 writes `ae2:z` so a wall-mounted charger can spin
about the face it is on. Apply it after `x` and `y`.

**`models.json`.** `elements` is the box geometry. Three optional fields carry what mods need:

- **`mesh`** — triangle geometry from an OBJ loader, as `[{ sprite, object?, positions, uv }]` with
  flat arrays: three vertices per triangle, `positions` in the same 0–16 block space as `elements`
  and `uv` in 0–16 sprite space. Winding is the OBJ author's, counter-clockwise seen from outside,
  so the normal is a cross product away. A model can have `elements`, `mesh`, or both. `object` is
  the OBJ's own `o`/`g` name, carried so a consumer can filter a multi-state file to one state.
- **`renderType`** — the layer the model *states* it draws on, one of `solid` / `cutout` /
  `translucent`. Authoritative where present, and it beats the per-sprite inference below: the same
  sprite can be solid in one model and translucent in another, which per-sprite alpha cannot express.
- **`multiblock`** — block offsets a split-multiblock mesh spans. See the mods section.

**`atlas.json`.** `sprites[id]` is `{ page, x, y, w, h, layer }`, plus `frames` and `interpolate`
when animated. `frames` is the displayed *sequence*, each entry `{ page, x, y, time }` with `time`
in game ticks — per-frame times rather than a single `frametime`, because an `.mcmeta` frame list
can give each frame its own duration and re-deriving that is exactly the resolution work this pack
exists to avoid. Physical frames are packed once and referenced, so a ping-pong list costs nothing
extra. `layer` is `solid` / `cutout` / `translucent`.

**`tints.json`.** `flat` holds the plains-climate colours (`grass`, `foliage`, `dry_foliage` sampled
from the version's own colormap; `water` from plains' `water_color`). `colormaps` names the copies
in the pack. `ramps` holds `redstone` (16, by power) and `stem` (8, by age). `blocks[id][tintindex]`
is one of `{kind: 'grass'|'foliage'|'dry_foliage'|'water'}`, `{kind: 'constant', color}`, or
`{kind: 'ramp', ramp, property}`.

**`biomes.json`.** `{ temperature, downfall }` per biome, plus `water`, `grass`, `foliage`,
`dryFoliage` and `modifier` where the biome overrides what its climate would give. A climate pair
addresses the triangular half of a colormap (`x = (1 - temperature) * 255`,
`y = (1 - downfall * temperature) * 255`, each clamped to 0-1 first); `modifier` applies to the grass
sample afterwards (`dark_forest` is `((c & 0xFEFEFE) + 0x28340A) >> 1`, `swamp` substitutes
`#6a7039`); an entry with no `water` is `#3f76e4`.

The file holds exactly the version's biomes under the names that version uses, so it doubles as the
biome list. The values come from the jar's own `data/<ns>/worldgen/biome/*.json` wherever it ships
them (vanilla from 1.19.3, a mod always), and only those are used. 1.13 to 1.19.2 kept biomes in
code, so they come from two frozen tables in `src/blocks/biomes.ts`, taken from the data generator's
own reports: 1.18 to 1.19.2 from 1.19.2's `worldgen/biome` report, and 1.13 to 1.17 from 1.17.1's
`biomes` report, under the pre-1.18 names (`mountains`, `giant_tree_taiga`). A pre-1.18 entry also
carries `id`, the number its chunks store the biome as, so a consumer decodes an old chunk against the
version's own registry instead of a table of its own. The climates differ by era: a 1.16 savanna is
1.2, not 2.

A modded pack describes its own biomes and nothing else. The file is absent when a pack has no biomes
to describe, and a consumer without one falls back to `tints.json`'s flat plains colours.

**`tags.json`.** Every tag the jar's datapack ships for the pack's namespaces, as
`{ [registry]: { [tag]: values[] } }`, unexpanded: a value starting `#` names another tag in the same
registry. Registries use the 1.21 singular folder name (`block`, `item`, `entity_type`, `fluid`,
`worldgen/biome`) at every version, since 1.21 renamed `tags/blocks` to `tags/block` and a consumer
should not have to care. An optional `{ id, required: false }` entry is written as its id.

**`advancements.json`.** Advancement id to the names of its criteria, from `data/<ns>/advancement/`
(`advancements/` before 1.21). Recipe unlocks are left out: the game grants hundreds of them silently.

**`states.json`.** Every block's properties with their values in the game's order, and its default
state: `{ properties?, default? }`, both absent for a block with none. `blockstates.json` only names
the properties that change a model, so it cannot say that stairs are `waterlogged` or what a freshly
placed block looks like. Nothing in the client jar says either. They come from the data generator's
`blocks.json` report (`java -jar server.jar --reports`), which needs a JDK, so the export only writes
this file when it is handed that report with `--reports <dir>`.

**`behaviour.json`.** What the block's `Properties` builder chain states, read in the same pass as
light (see `block-light.md`): `{ hardness, resistance, mapColor?, collision?: false, occludes?: false,
replaceable?, air?, liquid?, flammable?, pushReaction?, requiresTool?, randomTicks?, friction?,
speedFactor?, jumpFactor? }`, each flag written only when it is not the default. `mapColor` is the map
colour id (0 to 63; absent is 0, `NONE`), or per-state cases in `light.json`'s shape where a function
of state picks it: an oak log is 34 on its bark and 13 on its end grain. Before 1.20 half of this lived
on the block's `Material`, whose flags are read off the constant the registration named.

More come from the block's own class, where it overrides a method rather than stating a builder
call (`src/blocks/block-overrides.ts`). An override counts only where a class below the base declares
it, and it is run per state like a light function:

- `lightShape`: `useShapeForLightOcclusion`, so light crossing a face is tested against the block's
  shape. `true` for stairs, snow layers and farmland; cases for a slab, which is a full block when
  `type=double`.
- `lightBlock`: `getLightBlock`, the light lost passing through, where the class answers for itself:
  15 for tinted glass, 1 for leaves.
- `fluid`: `'water'` or `'lava'` for a block that holds it in every state, read off its
  `getFluidState` without running it: kelp, seagrass, bubble columns. A waterlogged block reads a
  property there, and its state already says so.
- `air`: also set from an `isAir` override, which is how an air block said so before 1.16.2.
- `invisible`: `getRenderShape` always answers `INVISIBLE`, so the block model renderer draws nothing:
  a barrier, a light block, a structure void, and blocks another renderer draws (fluids, end portals).
- `hidesSharedFaces`: the class decides whether a face against a neighbour draws (`skipRendering`):
  glass hides the faces it shares with glass although its texture reads as plain cutout.
- The equipment in `entity-models.json` states `undyed`, the colour an undyed leather piece takes,
  read from the game's own constant.

The rest of a block class's code is not followed. A class that overrides `canBeReplaced` or
`getMapColor` answers for itself at runtime. A sign's colour is its log's at the log's default state,
which only the data generator's report states, so without `--reports` signs carry no `mapColor` and
a `behaviour` failure each. 26.x registers dyed blocks through `ColorCollection` and coppers through
`WeatheringCopperCollection`, both of which are followed.

1.13 to 1.14.3 publish no mappings, so their builder calls have no names to read. The CLI reads
1.14.4's jar for them instead, asked for the older version's own block list, and `meta.json` records
`"behaviourFrom": "1.14.4"`. 1.14.4 has every 1.14 block; 1.13's `sign` and `wall_sign` (renamed
`oak_sign` in 1.14) have no entry and a `behaviour` failure each. That the blocks behaved the same in
the older release is an assumption nothing can check without its mappings.

**`game-rules.json`.** Every rule `GameRules` registers, by the name `level.dat` stores it under
(camelCase before 26.x, snake_case from it), as `{ type: 'boolean' | 'integer', default }`. Read from
the code, so vanilla packs only.

**`names.json`.** `{ block, item }`, English display names by id from each namespace's own `en_us`:
`minecraft:tnt` is "TNT", and before 1.20.3 `minecraft:grass` is "Grass".

**`items.json`.** The flat items — the ones the game draws as a stack of sprites rather than as
geometry, because `ItemModelGenerator` builds the slab in code and no asset states it. `items[id]`
is `{ layers: [{ sprite, tintindex?, tint? }] }` in the order the client stacks them; `tintindex` is
present exactly when the item declares a tint at that layer, and `tint` carries the colour where it
is knowable from assets (leather's default brown, a water potion's blue) and is absent where it lives
in the stack's components (a dyed boot, a firework star).

An item is in the file only if its own model is flat. A block item is deliberately absent, so a
consumer falls through to `blockstates.json` under the same id and draws the cube the game draws.
That test is what the game asks too, and it is why `minecraft:wheat` comes out right: the item is a
flat sheaf and the block of the same id is a crop cross.

The file is **self-contained** — its own `padding`, `pages` and `sprites`, on its own `item-atlas-N.png`
pages rather than the block atlas's. A consumer that only draws blocks never fetches it at all; one
drawing a world's dropped stacks fetches it once it finds a stack of something that is not a block.

**`entities.json`.** Every entity type the namespaces register, as `{ name, color?, texture?, model?,
width?, height? }`. `width` and `height` are the hitbox in blocks, read from `EntityType.Builder.sized`
in the code: the base size, before a baby or a large slime scales it. They are absent for 1.13, which
set sizes in each mob's constructor and publishes no mappings, and for a lang-only name such as
`killer_bunny`, which has no type of its own.

There is no geometry here and there cannot be: **no jar contains entity models, at any version** —
they are Java code, and 26.2 ships 850 entity *textures* against zero entity models. What a consumer
can do with this instead is name the stand-in box it draws for a mob and tint it like the animal, which
is the difference between a field of arbitrary colours and a readable one.

The registry is the lang file: `entity.<ns>.<name>` is written per registered type by datagen, so it
is the closest thing a jar carries to the entity registry. Keys with more segments are a variant's own
label (`entity.minecraft.villager.farmer`) and are not types.

`color` is the mean of the opaque pixels of the entity's own sheet — crude on purpose, since it is a
marker's tint rather than a render. It is **absent for everything that is not a mob**: an item entity,
a falling block, a marker, a display, a thrown projectile all draw from an item or a block and have no
sheet of their own, so none is invented for them. On 1.21.1 that is 111 of 132 types coloured.

Finding the sheet is the fiddly part, and `texture` carries the answer so the geometry does not have to
solve it again — `model` points into **`entity-models.json`**, which is that geometry. Entity models are
Java code at every version, so recovering them means reading the client's own bytecode, or converting
the bedrock `.geo.json` a GeckoLib mod ships in place of it; see `docs/entity-geometry.md` for how, and
for what it will not do. A cube there may carry `faces`, per-face texture rects that replace the box
unwrap `uv` implies — bedrock geometry leans on them and a Java model never has them. Most mobs are filed under their own name; the rest
are named after a *variant* (`entity/rabbit/brown`, `entity/guardian_elder`) or with the underscores
squashed out (`entity/armorstand/`, `entity/slime/magmacube`), and both are matched. The search never
leaves `entity/` — widening it tints a marker off whatever block happens to share a word — and never
takes a projectile or a piece of equipment filed in a mob's own directory, or a llama comes out the
colour of its own spit.

**`meta.json`** carries sha256 for every other file, because a consumer can cache these immutably per
version.

**`minecraft:missingno`** is a synthesized sprite, the black-and-magenta 16×16 the game draws for an
unresolved texture. Faces pointing at it are faces whose texture the mod did not ship or did not
bind; the game draws them the same way, so the pack does too rather than leaving a hole.

## Decisions

- **Infer the render layer from alpha.** A sprite whose alpha is only ever 0 or 255 is cutout;
  anything in between is translucent; fully opaque is solid. Right default, covers mods for free.
- **One version per pack**, immutable. Modded namespaces export separately so a consumer can fetch
  them on demand. Where and how the pack is hosted is up to the consumer.
- **Flat plains tint in v1**, but the colormaps ship in the pack, so real biome tints only need a
  per-biome temperature/downfall table on the consumer side — not a re-export.
- **Do not pre-render anything.** The consumer wants geometry, not pictures.
- **Nothing is dropped silently.** Every block, model, sprite and tintindex the run could not fully
  handle lands in `failures.json` with a reason, and the version-matrix test asserts that the only
  kinds present are the two that are statements about the assets rather than about the exporter.

## Resolved open questions

- **Weighted variant selection.** `weightedVariantIndex(weights, x, y, z)` is exported so both sides
  agree without inventing a scheme: it is `Mth.getSeed(x, y, z)` seeding a `java.util.Random`, then
  `WeightedBakedModel`'s `abs((int) nextLong()) % totalWeight`. Both halves are stable across
  1.13–1.21.3. 1.21.4 reworked the model system and parity there is unverified — the cost of being
  wrong is a grass block rotated differently from the game, so it is not worth chasing further
  until someone can diff it against a running client.
- **`.mcmeta` beyond animation.** Only `animation` matters here; the rest (`gui`, `texture`
  `blur`/`clamp`) does not affect geometry or atlas placement. `TextureLoader` already ignores it.
- **Modded texture sizes.** The packer's multi-page path works and is covered by a test at a forced
  128px page ceiling. Create + Immersive Engineering together still fit one 1024² page; a sprite
  too large for any page is reported in `failures.json`, and every face naming it is repointed at
  the missing-texture sprite, so no model names an id `atlas.json` has no entry for.
- **Atlas page size.** 4px padding inflates a 16×16 sprite to 24×24, which more than doubles the
  packed area — but vanilla still lands on a single page across the whole range (2048×1024 at 26.2,
  1024×1024 or smaller below it). The packer picks the smallest power-of-two that fits and only spills at the ceiling.
  Both page dimensions are always powers of two, so a `--max-page-size` that is not one is rounded
  down to the largest that is.

## Publishing and consuming a pack

### `@nodecraft/rendermite/pack`, the entry a renderer imports

The main entry is a Node toolchain: it reads jars, rasterizes with `sharp` and writes files, so it
can never enter a browser bundle. But a consumer of a *published* pack needs none of that — it needs
the format, and the one piece of logic the pack deliberately leaves at runtime, which is matching a
placed block's properties against its cases.

```ts
import { evaluateBlockState, weightedVariantIndex } from '@nodecraft/rendermite/pack';
import type { BlockPackAtlasFile, BlockPackModel, BlockPackBlockState } from '@nodecraft/rendermite/pack';
```

That evaluation is worth importing rather than reimplementing: it has a most-constrained-key rule for
the overlapping keys mods ship, and the wildcard retry described above. A consumer that reimplements
it and misses the retry draws a hole where every Functional Storage drawer stands.

`test/pack-entry.test.ts` bundles this entry the way a consumer's bundler would and fails on anything
that came along: it reaches two modules, pulls in no dependency and no `node:` builtin, and bundles
to under 32 KB. The types it exports are the ones `export.ts` writes each file `satisfies`, so the
format and the writer cannot drift.

**One caveat before depending on it.** A subpath export does not change what npm installs: taking
`@nodecraft/rendermite` as a runtime dependency still installs `sharp` and `lightningcss`, ~20 MB of
native binaries, for a 13 KB function. It is free for anything that already has rendermite in its
devDependencies — a build script, a test — and for a library shipped to third parties it is not, so
that case wants either these two moved behind optional peers or the entry split into its own package.

A layout that suits the pack, on any static host or CDN:

```
blocks/<version>/            one vanilla version, immutable
blocks/modded/<namespace>/   one mod's namespace, fetched on demand
```

**Over the wire** (1.21.8, gzip except the PNGs, which are already compressed):

| file | on disk | transferred | when |
| --- | --- | --- | --- |
| `atlas-0.png` | 330 KB | 330 KB | always |
| `models.json` | 1,863 KB | 88 KB | always |
| `blockstates.json` | 897 KB | 48 KB | always |
| `atlas.json` | 118 KB | 11 KB | always |
| `colormap/*.png` | 29 KB | 29 KB | only for real biome tints |
| `tints.json` | 2 KB | 1 KB | always |
| `biomes.json` | 4 KB | 1 KB | only for real biome tints |
| `light.json` | 10 KB | 2 KB | only for lighting |
| `behaviour.json` | 118 KB | 9 KB | only for editing and map art |
| `tags.json` | 26.2: 176 KB | 26 KB | only for tag patterns and masks |
| `advancements.json` | 26.2: 14 KB | 3 KB | only for a player's advancements |
| `game-rules.json` | 26.2: 3 KB | 1 KB | only for world settings |
| `items.json` | 170 KB | 14 KB | only for drawing dropped items |
| `item-atlas-0.png` | 86 KB | 86 KB | only for drawing dropped items |
| `entities.json` | 12 KB | 2 KB | only for naming and tinting entities |
| `entity-models.json` | 90 KB | 12 KB | only for drawing entity geometry |
| `entity-atlas-0.png` | 118 KB | 118 KB | only for drawing entity geometry |
| `failures.json` | 10 KB | 1 KB | diagnostics only, never at runtime |
| `meta.json` | 1 KB | 1 KB | always |
| **total** | **3.7 MB** | **739 KB** | |

An eight-mod pack (Create, IE, Mekanism, AE2, Botania, Supplementaries, Quark, Farmer's Delight) is
16.7 MB on disk and **1.8 MB transferred**, on one 2048² page.

**Caching.** A pack is byte-identical across runs — every map is key-sorted and nothing stamps a
time — so `blocks/<version>/` can be served `immutable, max-age=31536000` and `meta.json`'s sha256
per file is enough to verify a cached copy without refetching it. Serve the JSON with
`content-encoding: gzip`; the PNGs are already deflate.

**Load order.** `meta.json` first (counts and hashes, 1 KB), then `atlas-0.png` in parallel with
`blockstates.json` + `models.json` + `atlas.json`. Nothing needs `failures.json` at runtime,
nothing needs `colormap/` until biome tints are wired up, nothing needs `items.json` or
`item-atlas-N.png` until something draws a dropped stack, nothing needs `entities.json` until something
draws an entity, and nothing needs `entity-models.json` or `entity-atlas-N.png` until it draws one as
more than a box.

**Knowing what you do not have.** The pack answers this itself, without the sidecar:

- **Block not in `blockstates.json`** — this pack does not describe it. A modded block whose pack
  was never fetched lands here.
- **Evaluates to no case, or every case's model has empty `elements` and no `mesh`** — the game
  draws this block in code and nothing is vendored for it. 58 of 1,107 vanilla blocks after the
  substitutions below: banners, skulls, water, lava, air, barrier, light.
- **A face's sprite is `minecraft:missingno`** — the mod named a texture it did not ship or did not
  bind, and the game draws it black-and-magenta too. Drawing it is the faithful answer.
- **`particle` on the model** — every model carries its particle texture, so even a block with no
  geometry has a colour to draw a placeholder in: a chest comes out oak, a bed comes out wool.

`minecraft:missingno` is in **every** pack whether or not anything resolved to it, so it is always
available as the fallback for the first case as well — an unknown block can be drawn as a magenta
cube without inventing a texture. `failures.json` is the diagnostic view of the same facts, keyed by
model or block with a reason; it is for a build report, not for the renderer.

**What the viewer still has to build itself.** The pack is the asset source, not the renderer:

- **Fluids.** A fluid is a block here with no geometry, because the game meshes it from neighbouring
  fluid levels. The pack puts every fluid's textures in the atlas anyway — animation frames and all
  — so the mesher has pixels to work with, but the surface geometry is the consumer's. Which
  textures those are is read off the files by the `_still` / `_flow` / `_flowing` convention rather
  than listed, because mods add far more fluids than vanilla has and file them wherever they like:
  Create under `fluid/`, Immersive Engineering under `block/fluid/`, Mekanism under `liquid/`. Three
  mods together contribute 34 such sprites where vanilla has four.
- **Block entities that are still empty.** Banners and skulls come out empty and recorded — see
  below for the ones that no longer do.
- **Ambient occlusion.** `ao` says whether a model wants it; computing it is the mesher's job.
- **Biome blending.** `biomes.json` says what colour a biome is; the game averages a tinted block
  over the square around it, and which block neighbours which biome is the consumer's world to walk.
- **Break overlays and connected textures** are not in the pack at all.

## A state the world saved without every property

`evaluateBlockState` matches a case against the property map a chunk holds, and a mod's blockstate
can name a property that map does not have. Functional Storage's drawers are the case that surfaced
it: every one of their 32 cases keys on both `facing` and `subfacing`,

```json
{"when": {"facing": "down", "subfacing": "south"}, "apply": [{"model": "functionalstorage:oak_1"}]}
```

but a world saved before the block gained `facing` stores `{"subfacing": "south", "locked": "true"}`
and nothing else. The export is faithful, checked against the jar, so a strict read is right about
the data and still puts a hole where every drawer is.

So when no case matches, the cases are tried again with **any property the given map does not carry
at all treated as a wildcard**. A property that is present and disagrees still fails, so this is not
tolerance for a wrong value; it is a read of a state that predates the property. Two things bound it:

- **It only fires where the strict read found nothing**, so it can never change a state that already
  resolved. A multipart with an unconditional part therefore never reaches it.
- **At most one part per model**, so a drawer missing its `facing` draws one drawer rather than the
  six rotations of itself that six facings would otherwise all match.

A consumer that reimplements the pack's semantics rather than importing `evaluateBlockState` needs
this rule too. It is the difference between a wall of holes and a wall of drawers.

## Blocks the game draws in code

A chest's blockstate is one empty-key variant on a model with no elements:

```json
minecraft:chest      → {"variants":{"":{"model":"minecraft:block/chest"}}}
minecraft:oak_sign   → {"variants":{"":{"model":"minecraft:block/oak_sign"}}}
```

Not just the shape — the *orientation* is not in the assets either. A block entity renderer draws
the lot from Java. That was **144 of vanilla 1.21.8's 1,107 blocks**, and a world viewer reading
only the assets would put a hole where every chest and sign is.

rendermite already vendors box geometry for most of them, because the icon pipeline hit the same
wall years ago. `src/blocks/block-entities.ts` maps it onto blocks: it swaps the vendored model in
and **synthesises the orientation variants the blockstate never carried**, which works because the
consumer holds the block's real property map from the chunk even though the assets do not.

| family | blocks | geometry |
| --- | --- | --- |
| signs, wall signs, hanging signs | 48 | authored for this — `renderchest:block/{standing,wall,hanging}_sign` |
| banners, wall banners | 32 | authored for this — one model, 16 dyes from the tint table |
| shulker boxes | 17 | vendored, one per colour, oriented on all six faces |
| beds | 16 | authored for this — head and foot as a block each, `part` x `facing` |
| skulls, wall skulls | 14 | vendored mobheads geometry, translated off the item's centre |
| chests | 11 | vendored, plus authored halves for the double forms, `type` x `facing` |
| fluids | 3 | authored for this — a culled cube on the still sprite |
| conduit, decorated pot | 2 | vendored |
| copper golem statue | 8 | authored for this — 26.2 only, read off the entity sheet |
| **still empty** | **9** | air, barrier, light, structure void, moving piston, the two portals |

Three things keep this honest:

- **Every substituted model is named `rendermite:block/…`**, so nothing mistakes vendored geometry
  for something a jar shipped.
- **Every substituted block is recorded** in `failures.json` saying which model was swapped in.
- **The substitution stands down where the assets grow geometry of their own.** 26.2 ships real
  `block/oak_sign_rot_0` models with proper rotation variants, and the pack takes those instead —
  asserted by a test, because silently overriding the game's own shape with an approximation of it
  would be the worst outcome of the lot.

Passing no `builtin` turns the whole thing off and every one of the 144 goes back to being empty
and recorded.

### The block's own item model, for whatever the table cannot reach

A table of vanilla ids and a search over entity sheets close vanilla, and a good part of mods. What
they cannot reach is the rest of the long tail: a mod that builds a block's shape in Java files no
geometry anywhere the pack can find it.

But that mod still has to put something in the *inventory*, so it ships an item model with real
geometry, and that is the closest thing the assets hold to the block's shape. So a model that draws
nothing falls back to `<namespace>:item/<block name>`:

| block | item model | what it draws |
| --- | --- | --- |
| `enderio:conduit` | a 12³ cube on its own conduit texture | a conduit-coloured block |
| `extendedae:assembler_matrix_glass` | `block/cube_all` on the glass sheet | the glass block |
| `advanced_ae:quantum_structure` | `block/cube_all`, translucent | the structure block |
| `pneumaticcraft:pressure_tube` | `block/pressure_tube_inv` | the tube's unconnected shape |
| `ae2:quantum_ring` `formed=true` | `block/qnb/ring` | the ring, which is what a formed one is |
| `ae2:drive` | `block/drive/drive_base` | the drive, oriented by its own variants |
| `morered:red_alloy_wire` | the wire's full cross | a wire that reads as a connected run |

Three things keep it from over-reaching:

- **A flat icon is not geometry.** `item/generated` states no elements, so a 2D sprite never becomes
  a plane standing in a chunk. The same falls out for `builtin/entity` items. No test on the parent
  is needed, because the absence of elements is the test.
- **It is per model reference, not per block.** A state the mod builds in Java is filled in while the
  states with real models keep them (AE2's `formed=true`), and each case keeps its own `x`/`y`/`z`,
  so a drive still faces the way the blockstate says.
- **A part-magenta substitute is worse than the gap.** Same rule as the vendored geometry: if any
  sprite the item model names is missing, nothing is substituted and the block stays recorded.

It also runs where the blockstate itself could not be read at all. NeoForge lets a mod register a
model *type* and name it in a variant instead of a model, the way Ender IO writes
`{"variants": {"": {"type": "enderio:conduit"}}}`. That leaves no usable case, and the block used to
be absent from the pack entirely rather than merely empty.

Every substitution is in `failures.json` naming the item model it took, and the model keeps its
`item/` id in `models.json` so the pack says outright where the shape came from. Measured over 26
content-heavy mods: **160 blocks that drew nothing now draw**, Refined Storage 96 of them and Quark
35. Vanilla is untouched at every version, and a full 1.21.8 export is byte-identical: the nine
intentionally-invisible blocks are skipped and everything else was already covered.

`ae2:cable_bus` is the one mod id in the vendored table, because it is the one that earns it: 823 of
them in a real base, and none of the above reaches it. The cable type, the connections and every
attached part live in the block entity, its block model is `{}` and its item model is too. The basic
cable's centre core (`ae2:part/cable/glass/center`) is the one piece of it the assets do describe, so
that stands in and puts a marker where a network runs.

### The table is for vanilla; mods are searched for

A table of block ids covers vanilla and nothing else. `ironchest:crystal_chest` keeps its sheet
wherever it likes, `cobblemon:apricorn_sign` does not file its board under `entity/signs/`, and
`spectrum` ships heads for 90 mobs. Measured across 60 mods and 21,177 blocks, keying off vanilla
ids alone left **645 blocks empty** that the pack had geometry for.

So the block pack uses the same discovery the icon renderer has always used, now shared in
`src/resources/entity-textures.ts` rather than written twice: the sheet is found by token overlap
with the block's name, over the mod's own textures. `findChestTexture`, `findMobTexture`,
`findBedTexture`, `findEntityTexture` and `findFluidStill` are one module used from both ends.

| family | before | after | what the search does |
| --- | --- | --- | --- |
| signs | 181 | 0 | falls back to a search when `entity/signs/<wood>` is not there |
| chests | 155 | 2 | scores the mod's own chest sheets, wherever they live |
| shulker boxes | 64 | 0 | gated on the sheet being a whole skin, not a tier overlay |
| skulls | 244 | 122 | 90 vendored mobs by name, then the mod's own sheet by skin size |
| fluids | 19 | 6 | matches the block name against `<name>_still` in its namespace |
| banners | 2 | 1 | the mod's own base sheet, else vanilla's |

Two things this turned up that were not about mods at all. The vendored heads were authored against
current vanilla, which files an entity sheet under its own mob folder (`entity/bat/bat`); older
versions keep them flat (`entity/bat`), so any binding that does not resolve is now looked up again
by name — worth 70 blocks on its own. And a double chest's halves are not always suffixed: vanilla
writes `normal_left`, quark files `left` beside `normal`, so both are tried.

What is left is the honest limit of name matching. `botania:gaia_head` is a head for the Gaia
Guardian, whose sheet botania calls `doppleganger`; Immersive Engineering's `phenolic_resin` fluid
has a sprite called `resin_still`. Loosening the match to catch those would start binding
`biodiesel` blocks to `diesel` sprites, which is worse than a recorded gap.

Iron Chests, the mod that prompted the question, needs none of this: it ships real block models and
was never empty.

Some of these needed more than one shape per block, which is what the `shapes` list is for. A bed
splits on `part`; a chest splits on `type`.

### Double chests

Two chests placed side by side stop being two chests. Each keeps its own block but takes a `type`
of `left` or `right`, and the game swaps in a **15-wide** box on a wider sheet so the pair reads as
one container with a single lock on the seam. Drawing two singles instead leaves a join down the
middle and two lids.

The halves are derived from the sheet rather than drawn, because Minecraft unwraps an entity box by
a fixed rule and the vendored single chest already pins that rule down. Two things bit on the way:

- The side band runs `d, w, d, w`. Writing the third boundary as `u + d + 2w` reproduces the single
  chest exactly and is still wrong, because a single chest is as deep as it is wide and a double
  half is not.
- The vendored single chest labels that band's **east and west the other way round on its body box
  than on its lid**. Its two side textures are near identical so the slip never showed, but on a
  double chest it puts the blank seam end on the outside — a black hole where the chest should be.

The tie-break was the sheets themselves. `normal_left` leaves nothing where its west face samples
and `normal_right` nothing at its east, which says which end is the seam and agrees with
`ChestBlock.getConnectedDirection` putting a left half's partner clockwise of its facing.
The join was then measured in all four facings, since a one-pixel gap is not something an isometric
render will show you.

### Fluids

Flowing states are the one family the pack deliberately does not bake, and it is worth being precise
about why. `LiquidBlockRenderer` computes each corner of a fluid's surface by averaging the heights
of the block and its eight horizontal neighbours, and takes the flow angle from the gradient across
them. `level` alone does not determine any of it.

Baking per-level heights would also make the common case *worse*. An ocean is level 0 throughout,
including the blocks below the surface, and vanilla only shortens a fluid whose neighbour above is
not the same fluid. Emitting a 14-pixel box for every level 0 block would band a whole ocean with
2-pixel gaps. A full cube is both simpler and the better naive answer.

So the block is a full culled cube, and the model states what a consumer needs to mesh the real
thing:

```json
"rendermite:block/water": {
  "elements": [ … ],
  "fluid": {
    "still":   "minecraft:block/water_still",
    "flow":    "minecraft:block/water_flow",
    "overlay": "minecraft:block/water_overlay"
  }
}
```

That block is the point. The flow sheet was always in the atlas, but nothing named it, so a consumer
had to guess `<block>_flow` — which works for vanilla and fails for every mod: Create files fluids
under `fluid/`, Immersive Engineering under `block/fluid/`, Mekanism under `liquid/`. The sheets are
now found as siblings of the still one, which also keeps lava from borrowing water's overlay, since
only water has one.

The cube itself follows the renderer where it costs nothing: the still sheet on the flat faces and
the flow sheet on the sides, sampling its top-left quarter as `LiquidBlockRenderer` does.

For a consumer that wants the real surface, the height rule is
`(8 - min(level, 7)) / 9`, full for a falling fluid (`level >= 8`) or one with the same fluid above.

### What stays empty

Nine blocks, and the pack now says so rather than leaving a hole. `air`, `cave_air` and `void_air`
draw nothing; `barrier`, `light` and `structure_void` only appear while the player holds one;
`moving_piston` is a placeholder the piston draws for; `end_portal` and `end_gateway` are shader
effects rather than geometry. They land in `failures.json` under a kind of its own:

```js
failures.filter(f => f.kind !== 'intentional')   // the real gaps
```

Two guarantees hold across every version and every mod pack tested, and both are asserted:

- **No empty block is silent.** Anything that draws nothing has an entry in `failures.json`, whether
  it is empty on purpose or a gap no geometry is vendored for.
- **No substitution is part magenta.** Vendored geometry is a guess about a block the assets do not
  describe, so a half-bound one reads as a broken texture rather than a gap. If any texture it names
  is missing, the block is left empty and recorded instead.

### The copper golem statue

26.2's statue was the last vanilla block with nothing to draw, and it is the hardest kind: the game
draws it entirely from Java, the jar's model carries only a particle texture, and 26.2 ships no
entity geometry as data either. So it was **read off its own texture**.

A Mojang entity sheet is an unwrap, and an unwrap is measurable. Printing the alpha channel shows
nine islands, and each island's dimensions give back the box that made it — a top band `d` rows tall
and `2w` wide, a side band `h` rows tall and `2d + 2w` wide:

```
rows 0–9    x 10–25   →  top band, d=10, 2w=16   ┐
rows 10–14  x 0–35    →  side band, h=5, 2d+2w=36 ┘  head: 8 x 5 x 10 at texOffs(0,0)
```

Nine boxes came out that way: head, beak, antenna stem and top, body, two arms, two legs. Four of
them are then pinned exactly rather than guessed, because `mobheads:item/copper_golem` is vendored
for the icon pipeline, reads the same sheet at the same offsets, and states its boxes and UVs
outright. The unwrap formula reproduces its head and antenna to the pixel, which is what makes the
other five trustworthy.

Two details the sheet also settled:

- **Which way it faces.** The eyes sheet has 8 opaque pixels in the head's north band and none in
  the other three, so the model is authored facing north — the opposite of the chest, which is why
  the same unwrap labels their east and west differently.
- **The overlay.** The vendored head item leaves its eyes layer coplanar with the head, which a
  rasterizer resolves by draw order and a depth buffer does not. The block version is nudged out by
  0.02 units: enough to win, not enough to see.

The properties came from the wiki rather than the assets, which do not carry them: `facing`,
`waterlogged`, and `copper_golem_pose` with `standing`, `sitting`, `running` and `star`. Only
standing is authored — the other three differ by limb rotations nothing records — so the cases key
on `facing` alone and every pose draws the standing statue rather than a hole.

**That closes vanilla.** Every version from 1.13 to 26.2 now exports with the only empty blocks
being the nine the game itself draws nothing for, and the version matrix test asserts it.

## Mods

Vanilla is the easy half. The mod work was driven by exporting a pack per jar across the corpus and
bucketing the failures (the same approach as `scripts/coverage/`) rather than guessing at what mods
do. Everything below is a class the survey surfaced, in the order it cost
the most geometry.

### OBJ geometry — the big one

Forge and NeoForge let a block model point at an `.obj` instead of stating `elements`, and mods use
it for everything a box cannot express. Across 59 named mods that is **237 block models**: Create's
crushing wheels, blaze burners, flywheels and valve handles; Immersive Engineering's slopes,
connectors, chutes and split multiblocks; Mekanism's pipes, cables and transporters. Before this,
every one of them exported with nothing to draw.

Triangles are a superset of boxes and a GPU consumer draws them more easily, so `models.json` gained
a `mesh` rather than trying to approximate a mesh with boxes. `src/blocks/obj-mesh.ts` reuses the
icon pipeline's `parseObj`/`parseMtl` and material binding unchanged; the only translation is 0–1
block space to the pack's 0–16, and OBJ's 0–1 UVs to 0–16 sprite space. IE's `.obj.ie` files parse
the same way. A mesh over 20,000 triangles is reported rather than emitted.

### One OBJ, several states

The catch with OBJ is that a file often holds *more than one state of the block*. IE's `ie_obj`
loader packs them in as named objects and picks between them in a Java callback: a workbench draws
its blueprint only when one is inserted, a post grows arms only toward neighbours, a logic unit
shows a board per installed circuit, a floodlight has separate lamp-on and lamp-off objects. 44 IE
models do this.

Drawing all of them is worse than drawing none, because it looks like it worked — an alu post came
out with arms in every direction, a lantern with brackets on all six sides, a fluid pipe as a solid
knot of every connection shape. **The model files name the callback and nothing else**, so there is
no data source for the right subset. Three things, in order of how much they are guessing:

1. **Every mesh group carries its `object` name.** No guessing, strictly more data, and it lets a
   consumer filter to one state.
2. **A model whose loader declares a runtime selector and got no restriction is recorded**, listing
   the objects, so a wrong-looking block is traceable to the reason rather than looking like a pack
   bug. It is gated on the selector, not on the object count: Create's track models are 37 named
   groups that all draw together, and flagging those would be crying wolf.
3. **A curated default per callback, for the ones whose default is unambiguous** — following the
   same per-mod convention `MOD_LOADER_HANDLERS` already uses. Currently `workbench` (blueprint is
   inserted contents), `post` and `lantern` (connections need neighbours) and `logic_unit` (boards
   are installed circuits). Each was checked by rendering it. `chute` was in this list and came
   out wrong — `base` is only the frame, not the walls — so it was removed rather than kept on the
   strength of the reasoning. Everything else keeps drawing all objects, recorded.

### Broken mod assets must not lose geometry

Three separate cases, all of which used to drop something:

- **`#missing` and absent textures.** Blockbench writes `"texture": "#missing"` on faces nobody
  assigned, and mods name textures they forgot to ship (Spectrum's `stripped_gala_log`). That is
  620 faces and 111 sprites across the corpus. The game draws them in black and magenta; the pack
  now points them at `minecraft:missingno` instead of deleting the face, which shows the mod's bug
  rather than inventing a hole.
- **One bad case must not take the block with it.** AE2's `crafting_monitor` states no model for
  `formed=true` because the game draws that state itself. That one case used to fail the parse and
  lose all eleven others. `parseBlockState` now takes an `onCaseError` handler; the exporter drops
  the case, records it, and keeps the rest.
- **A model the pack cannot carry must not be named.** AE2 builds its `*_formed` models in Java, so
  no file exists to read — 99 references across the corpus. Blockstates are now serialized *after*
  the models resolve, and a variant naming a model that did not export is dropped from the emitted
  case. The pack never hands the consumer a model id it does not carry, which is the one invariant
  the whole contract rests on.

### Loader extensions vanilla has no equivalent for

- **`render_type`** — 893 modded block models state their layer outright. Where a model says so it
  is authoritative, and `renderType` on the model beats the per-sprite alpha inference.
- **`extra_rotation`** — an arbitrary angle on an element, past vanilla's 22.5° steps.
  Supplementaries slants its awnings with it. Folded into the element's rotation angle by the model
  loader, so the icon renderer gets the fix too; ignoring it silently flattened the awnings.
- **A third rotation axis** — AE2 writes `ae2:z` on blockstate variants so a wall-mounted charger or
  drive can spin about the face it is on. 17 blockstates use it, several with real geometry.
  Any `z` or `<ns>:z` numeric key is read; only a number can match, so the probe is safe.
- **A loader naming its delegate `model`** — the same shape as `delegate` and `childModel` under the
  loader's own spelling (Supplementaries' faucet). Redirected as a parent.
- **`neoforge:definition_type`** — NeoForge 1.21.6+ lets a mod register a blockstate *definition*
  loader the way it can register a model loader, and the file then carries the loader's own shape
  instead of `variants`. Only the fallback is recoverable from assets, and it is the right one:
  `base_model` is what the block looks like before the loader runs. FramedBlocks' 233 camouflage
  blocks went from 22 exported to 255 on this alone. Recorded, since a camouflage block will not
  reflect what is inside it.

### Multiblocks

IE's `basic_split` wraps one mesh spanning several block positions — a coke oven's model is the
whole 2×2×2 structure — and hands each position its own slice at draw time. **Which slice is in the
block entity, not in the assets**, so no amount of asset reading recovers it. The pack carries the
whole mesh plus `multiblock`, the offsets the structure spans, and records the model in
`failures.json` so the consumer knows to draw it once from a corner rather than once per position.

### Looking for geometry that is wrong rather than missing

The sidecar only knows about things the exporter could not do. A block that exports happily and
draws its every state at once looks like a success in every count. So a second sweep over the same
corpus reads the *emitted* packs and flags shapes that read as wrong: a model whose every face is
the missing-texture sprite, geometry a long way outside its own block with no multiblock to explain
it, the identical element twice over, a mesh whose objects are mutually exclusive, zero-volume
boxes. Two real bugs came out of it.

- **Sophisticated Storage's barrels were 114 elements for a box.** The loader states two part
  groups — the partitioned and plain variants of the same barrel — and within each, `_open`,
  `locked` and `packed` are states rather than additions. Merging the lot stacked
  `barrel_part/base` four times. Now the plain group is taken, states are skipped and repeats
  deduplicated: **114 elements → 13**. This one predates the block pack; the icon renderer had been
  drawing four barrels on top of each other too.
- **"Every face is magenta" is now said once per model** rather than left to be inferred from a
  face-by-face scan, so a consumer can hide the block instead of showing a magenta box. 2,381
  models across the corpus, and they are faithful: Ars Nouveau's alteration table names `#3` on
  every face and binds only `particle`, so the game draws it magenta too.

The rest of what the sweep found is expected content: 2,412 meshes with many named groups that all
legitimately draw together, and 2,210 models with a genuinely duplicated element, which is what a
Blockbench user pressing duplicate produces. Those pass through verbatim.

### How the mod path is tested

Three layers, because each catches what the others cannot:

- **Synthetic assets** (`test/block-pack-mods.test.ts`) — one isolated case per class, with the mod
  that motivated it named on the test. Fast, and it pins the exact behaviour rather than a count.
- **Real jars** (`test/block-pack.test.ts`) — two modded cases from Modrinth, downloaded at test
  time. Create, Immersive Engineering, Mekanism, AE2 and Botania loaded together as one Forge 1.20.1
  pack (which is also what stresses the atlas packer), and Supplementaries with FramedBlocks as a
  NeoForge 1.21.1 pack for the newer loader extensions. Both assert the pack is self-contained and
  that the only sidecar entries are shapes spelled out in `MODDED_ALLOWANCES` — a `model` entry
  whose reason is anything but "Model not found", or a `texture` entry that is not the missing-sprite
  substitution, still fails the run.
- **Looking at it.** Counts cannot see a block that exports happily and draws wrong. The floating
  blueprint on IE's workbench passed every count and every assertion; it was found by rendering the
  pack and looking, drawing a sample across every namespace in a pack.

### What mods still cannot give us

- **Connection state is not in the blockstate.** Mekanism's cables and IE's pipes keep every
  connection state in one OBJ and pick per neighbour at runtime, from the block entity. Mekanism's
  is restricted to the unconnected centre, which is what an isolated cable looks like; IE's pipe
  has 17 objects and no obvious default, so it draws all of them and says so. Both carry their
  object names, so a consumer that learns the rule can filter without a re-export.
  MoreRed's 18 wire families are the element-model version of the same thing: `morered:wire_parts`
  holds the two shapes a wire draws *between* blocks (`line` across a face, `edge` around its corner)
  and picks per neighbour in Java. Neither is the wire, and taking whichever the file named first put
  a stub in the corner of every wire in the world, so the loader draws nothing and the wire falls back
  to its item model's cross, which tiles into a continuous run.
- **Connected textures** (Continuity, Chipped's CTM) live in `optifine/ctm/` or a mod's own format
  and describe *runtime* sprite selection from neighbours. Out of scope for the same reason: the
  pack describes a block, not its neighbourhood. Chipped's 6,981 blocks export fine without it.
- **Blocks drawn in code** keep whatever shape the assets hold: the item model where there is one,
  nothing where there is not. After the OBJ work, 574 of the corpus's remaining empty models have no
  loader at all: they are genuinely code-built (Sophisticated Backpacks, Create's kinetic overlays),
  and the ones whose mod ships an inventory shape now stand on it.

## Known gaps

- **11 vanilla tintindexes have no table entry** (1.21.8): `bamboo`, `bamboo_sapling`, `bush`,
  `cherry_leaves`, `lava_cauldron`, `leaf_litter`, `pale_oak_leaves`, `pink_petals`,
  `powder_snow_cauldron`, `stonecutter`, `wildflowers`. Some are correct as-is — cherry and pale oak
  leaves inherit their tintindex from `block/leaves` and vanilla registers no colour for them, so
  untinted *is* what the game draws. Others (`bamboo`, `leaf_litter`) declare it themselves and
  probably want a colour. Closing them means reading `BlockColors.createDefault()` for the target
  version; until then they are in `failures.json` rather than quietly grey.
- **Blocks the game draws in code** export as whatever the assets hold: vendored geometry where the
  table or the entity-sheet search reaches them, the block's own item model where the mod ships one,
  and nothing at all otherwise. All of them are listed in `failures.json` with kind `geometry`, so
  the consumer can say so in its UI rather than looking broken. A substitute carries a shape and not
  an orientation, and for a cable or a pipe not the connections either, so a wire drawn from its item
  model reads as connected in every direction rather than only the ones it is.
- **Modded tintindexes are the bulk of the sidecar**, 1,066 across the corpus. A mod's block colours
  live in its Java, exactly as vanilla's do, so there is no data source short of a per-mod table.
  They export untinted and say so.
- **Supplementaries' `flower_box` and `frame_block`** name their content under keys nothing else
  uses (`box`, `overlay`), and the frame's real geometry is the block it mimics. 21 models,
  unrecovered.

## Measured

Full vanilla export, `.work/fixtures/<version>-client.jar` through `prepareVersionResources`:

| version | blocks | models | sprites | atlas page | time |
| --- | --- | --- | --- | --- | --- |
| 1.13.2 | 599 | 924 | 504 | 1024×512 | 1.1s |
| 1.18.2 | 900 | 1,563 | 780 | 1024×1024 | 1.7s |
| 1.19.4 | 1,000 | 1,790 | 855 | 1024×1024 | 1.9s |
| 1.21.1 | 1,062 | 1,925 | 973 | 1024×1024 | 2.2s |
| 1.21.4 | 1,097 | 1,991 | 1,000 | 1024×1024 | 2.3s |
| 1.21.8 | 1,107 | 2,015 | 1,044 | 1024×1024 | 2.3s |
| 26.2 | 1,198 | 2,380 | 1,230 | 2048×1024 | 2.9s |

One pack per mod jar, mod namespaces only, over vanilla:

| mod | blocks | models | sprites | atlas | time | sidecar |
| --- | --- | --- | --- | --- | --- | --- |
| chipped | 6,981 | 9,827 | 7,252 | one page | 27.4s | 33 tint, 4 texture |
| spectrum | 1,306 | 1,801 | 1,179 | one page | 7.1s | 25 tint, 32 texture, 7 geometry |
| quark | 809 | 1,383 | 514 | one page | 3.0s | 62 tint, 42 geometry, 34 model |
| botania | 678 | 1,241 | 497 | one page | 2.9s | 25 tint, 34 geometry |
| create | 643 | 1,459 | 707 | one page | 3.6s | 6 geometry, 1 tint |
| immersive engineering | 295 | 899 | 353 | one page | 2.3s | 65 geometry, 1 tint |
| handcrafted | 267 | 12,016 | 922 | one page | 14.8s | none |
| mekanism | 201 | 273 | 405 | one page | 1.5s | 21 geometry, 9 tint |
| ae2 | 102 | 192 | 117 | one page | 0.7s | 14 geometry, 6 texture, 3 tint, 1 model |

Across 59 named mods: **20,941 blocks, 60,251 models, 22,617 sprites, no run errored, none needed a
second atlas page.** Eight of them loaded together as one modpack come to 3,088 blocks and 3,210
sprites on a single 2048² page, with 152 OBJ meshes, 320 models stating a render layer and 49 split
multiblocks; forced to a 1024 ceiling the same pack spills cleanly to three pages.

Breadth: a pack per jar over the whole 3,000-jar coverage corpus — **1,202 of them ship blocks, and
those export 147,240 blocks with no run erroring.** That sweep is what found the classes above; the
last of them, NeoForge's blockstate definition loaders, came out of the tail of it.

What the work changed, measured on the same 59 jars: models with nothing to draw **907 → 627**;
geometry dropped for a texture the mod did not ship or bind **699 → 0** (588 faces and 111 sprites,
all now carrying the missing-texture sprite); blockstates lost whole to one bad case **23 → 0**;
dangling model references in `blockstates.json` **99 → 0**.

1.21.8 on disk: `atlas-0.png` 316 KB, `models.json` 1.9 MB, `blockstates.json` 919 KB,
`atlas.json` 119 KB. The JSON gzips well and caches immutably.

## Notes for consumers

A consumer typically decodes chunk block states and meshes them against this pack. Writing the
mesher against a block-access interface rather than a chunk lets structures and schematics render
through the same path.

The 1.13 floor obliges a chunk decoder to handle three section layouts, not one: 1.13–1.15 pack palette
indices tightly across long boundaries, 1.16–1.17 pad so an index never straddles two longs, and
1.18+ moved sections to the chunk root under `block_states`. All three are namespaced, so all three
are in scope for this pack — a version this exporter supports is one the consumer must be able to
read.
