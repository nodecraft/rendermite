# Curated mod geometry overrides

Element models for mod items the game draws in code. A `builtin/entity` item model carries
display transforms and no `elements`, so the boxes only exist in a Java class: no fallback in
`src/render/pipeline.ts` can find them and the item fails into the failure sidecar. Layout is
`<namespace>/models/item/<path>.json`, ordinary vanilla model JSON, mounted with
`FolderResourceManager` (see `src/mods/models.ts`).

**These files are generated — do not hand-edit them.** Run:

```sh
node --experimental-strip-types scripts/mod-models/build.ts
```

`scripts/mod-models/extract.ts` reads the box list straight out of the mod's bytecode via
`javap`, so no geometry number here is hand-copied. The per-item spec in
`scripts/mod-models/build.ts` supplies only what bytecode can't give mechanically — the pose,
the texture, and which parts draw emissive or translucent — with each value citing the class
it came from. Regenerating after a mod update is one command; review the resulting diff.

## Precedence

This pack layers **above** the mod jars, so it shadows the jar's `builtin/entity` stub in
every era. Because it replaces that stub outright, the generator copies the `display` block
verbatim out of the jar's own model — the override is the whole model, not a patch.

## Renderer extensions

Two non-vanilla element fields exist for this pack, both read in `src/render/geometry.ts`:

- `emissive_rc: true` — skip directional shading, standing in for a fullbright render type.
- `alpha_rc: <0..1>` — constant opacity multiplier for a translucent element.

## How the pose is baked

Geometry keeps Java's handedness — `from`/`to` are the raw `addBox` bounds — and the whole
renderer transform is folded into each element's single rotation by `scripts/mod-models/pose.ts`.
Keeping Java's handedness is what lets the UVs stay the plain entity-sheet unwrap with no
mirroring anywhere.

A spec states the pose as the op list the renderer literally runs, so it reads against the
bytecode: Mekanism's `translate(0.5, 0.5, 0.5)` + `Axis.ZP 180°`, Botania's
`translate(0.5, 1.5, 0.5)` + `scale(1, -1, -1)`. Both are rigid — a mirror on two axes has
determinant +1, so it *is* a rotation — which means the composite of the pose, any per-part
pose, the part's `PartPose` offset and its rotation is always `p -> C + s·M·p` for a single
rotation `M`. An element expresses exactly that: place the box at `s·box + C` and rotate about
`C` by `M`, with `M` written as X-then-Y-then-Z Euler angles.

`decompose` throws rather than approximating if a pose ever carries a non-uniform scale or a
true reflection, since neither fits in one element and silently rounding would ship a wrong
icon.

## UVs

Java entity sheets are not 16×16, and the renderer has no `texture_size`: it normalizes `uv`
by 16 and multiplies by the real texture dimensions, so pixel coordinates are pre-scaled into
0–16 space (`u * 16 / sheetWidth`, `v * 16 / sheetHeight`).

The unwrap, in Java model axes: the row at `v` is `down` then `up` (each w×d); the row at
`v + d` is `west` (d), `north` (w), `east` (d), `south` (w).

The rect arithmetic is confirmed against the vendored renderchest chest model, whose UVs match
it exactly on every element. The assignment *within* the `up`/`down` and `east`/`west` pairs is
not independently confirmed — a chest's left and right faces are texture-identical, and
renderchest's own file disagrees with itself on `east`/`west` for that reason. It agrees with
`src/render/geo.ts`'s GeckoLib-validated table under the Java↔Bedrock double mirror (x and y),
which is the expected relationship, and swapping either pair changes these renders very little
because opposite faces of an entity-sheet box carry near-identical detail. Worth nailing down
against an in-game screenshot if an item ever looks subtly mirrored.

## Entries

### Mekanism 10.7.19 (1.21.1, NeoForge)

Six `builtin/entity` items, all `MekanismISTER`s posed with the default bake. Textures live in
`assets/mekanism/render/`, outside `textures/` — reached through `TextureLoader.decode`'s `raw`
fallback. Emissive and translucent groups come from each model's `render()` and
`renderToBuffer()`: a `litParts` list draws at light `15728880`, and the glass-like groups
additionally carry an alpha in their vertex colour.

| item | model class | sheet | parts | groups |
| --- | --- | --- | --- | --- |
| `atomic_disassembler` | `ModelAtomicDisassembler` | 64×32 | 16 | 5 blade parts emissive @ `0xBF` alpha |
| `flamethrower` | `ModelFlamethrower` | 64×64 | 23 | one opaque list |
| `scuba_tank` | `ModelScubaTank` | 128×64 | 9 | one opaque list |
| `free_runners` | `ModelFreeRunners` | 64×32 | 6 | opaque; extra `translate(0,-1,0)` |
| `jetpack` | `ModelJetpack` | 128×64 | 21 | 4 lit parts; 2 wings emissive @ `0x34` alpha |
| `scuba_mask` | `ModelScubaMask` | 128×64 | 28 | 2 lit parts; 6 glass emissive @ `0x4D` alpha |

Mekanism's other ten `builtin/entity` items are the energy cubes and fluid tanks, which are
assembled from block models in code rather than from a Java entity model, so they are not
portable this way.

### Botania 454 (1.20.1, Forge)

Botania ships no item renderer of its own: `TEISR` hands the stack straight to the block's
`BlockEntityRenderer` with a **dummy block entity**, so each item's pose is that renderer's
in-world pose — the standard `translate(0.5, ~1.5, 0.5)` + `scale(1, -1, -1)` block-entity
flip rather than Mekanism's `Rz(180)`. Sheet sizes are registered in `BotaniaLayerDefinitions`,
not the model class, so the specs state them explicitly. The jar is SRG-mapped; class names
survive and descriptors disambiguate every call except `PartPose.offset`/`rotation`, pinned by
`SRG_ROTATION` in `extract.ts`.

| item | model class | sheet | parts | animated? | notes |
| --- | --- | --- | --- | --- | --- |
| `avatar` | `AvatarModel` | 32×32 | 6 | no | null level → facing SOUTH → `ROTATIONS[0]` = 180° |
| `bellows` | `BellowsModel` | 64×32 | 4 | no | funnel posed separately; squeeze fraction is 1 |
| `hourglass` | `HourglassModel` | 64×32 | 5 | frozen by Botania | sand skipped — an item holds none |
| `corporea_index` | `CorporeaIndexBlockEntityRenderer` | 64×32 | 3 | yes | geometry lives in the renderer; ring drawn twice, nested |
| `teru_teru_bozu` | `TeruTeruBozuModel` | 64×32 | 3 | yes | `happy_face` skipped (rain variant) |
| `brewery` | `BotanicalBreweryModel` | 32×16 | 10 | yes | `plate` drawn 7× round a circle |
| `mana_pylon` | `ManaPylonModel` | 64×64 | 8 | yes | 4 crystal shards emissive |
| `natura_pylon` | `NaturaPylonModel` | 64×64 | 12 | yes | 8 crystal shards emissive |
| `gaia_pylon` | `GaiaPylonModel` | 64×64 | 12 | yes | 8 crystal shards emissive |

Botania special-cases the item path in several of these, and the specs follow it rather than
guessing: the pylon renderer takes `1.35` instead of `1.5` when the block entity is null, the
corporea index scales by `1.3` and drops `0.1`, and `HoveringHourglassBlockEntityRenderer`
**zeroes its own clock** when there is no world — so the hourglass icon here is exactly the
frame the game draws, not a still we picked.

`teru_teru_bozu`, `brewery`, `corporea_index` and the three pylons do keep spinning in the inventory, because
their renderers read `ClientTickHandler.ticksInGame` unguarded. Those six are a **chosen
still: frame 0**, matching how the renderer already takes frame 0 of an animated texture. The
position-seeded spin offset those renderers add is correctly absent, since it is guarded on the
block entity being non-null. At frame 0 most sin/cos terms vanish, which is why the pylons' ring
and crystal poses collapse into one; the brewery's plate heights are the exception, staggered by
`sin(i·40)` even at tick 0, exactly as in game on that tick.

All nine of Botania's `builtin/entity` items are ported.
