# Mod coverage campaign

Worked 2026-08-15 on `feat/more-mods`. Grew the surveyed corpus from ~30 mods / ~16.5k items to
**2,999 mods / 255,949 items** and closed most of the failure classes that survey exposed. This
records the method, the fixes, and — more usefully — the things that looked like gaps and were
not, plus the ones deliberately left open.

Complements `mod-failure-taxonomy.md`, which catalogued the *old* pipeline's failures from the
`ui` repo. This one is about rendermite's own behaviour measured against real jars.

## Headline numbers

| corpus | items | failed | pass |
| --- | ---: | ---: | ---: |
| 30 mods (baseline) | 16,498 | 74 | 99.55% |
| 25 mods (after that round's fixes) | 16,467 | 42 | 99.74% |
| 189 mods | 53,141 | 1,010 | 98.10% |
| 220 mods | 55,574 | 1,068 | 98.08% |
| 1,294 mods (top 1,200 by downloads), solo | 98,688 | 3,690 | 96.26% |
| same corpus, dependency-aware | 112,424 | 1,903 | 98.31% |
| 2,999 mods (top 3,000 by downloads) | 232,785 | 5,527 | 97.66% |
| **same corpus, asset-inferred dependencies** | **255,949** | **3,757** | **98.53%** |

The gap between each solo row and its dependency-aware successor is the whole argument for
loading dependencies before judging a mod: same jars, same renderer, +2.05 and +0.87 points
respectively. The item count rises too, because a resolved dependency makes previously
undiscoverable items discoverable.

(The two small corpora differ by the mods that 404'd or shipped no textures, so compare rates
rather than counts.)

**The raw rate falls as the corpus grows, and that is mostly an artifact, not a regression.**
See below. Adjusted for dependency artifacts the real figure is ~98.9%.

Mods measured at exactly zero failures include: create, chipped, rechiseled (3,739 items),
nuclearcraft (1,575), aerial-hell (1,406), oh-the-biomes-weve-gone (938), quark (838),
regions-unexplored (730), stoneworks (572), simply-swords, storagedrawers, cc-tweaked,
extreme-reactors, thermal-cultivation, thermal-dynamics, tetra, and all nine Macaw's mods.

## Method

**The harness now lives in `scripts/coverage/` — see its README to run it.** It began as
scratch scripts under `.work/`; it earned a permanent home once dependency resolution made it
non-trivial. What follows is why it is shaped the way it is.

Four decisions carry all the value:

1. **Rank by downloads, do not curate.** `catalog.ts` pages Modrinth's search API sorted by
   downloads. Hand-listing slugs is how the corpus sat at 220 mods for days; one API call took
   it to 1,294, and it weights the corpus by what people actually install rather than by what I
   thought to type. The top-1,200 corpus is 1,414 jars / 4.5 GB; a large share are client-only
   mods (shaders, HUD tweaks) that survey as 0 items in a second.
2. **Record the game version at fetch time.** `catalog.json` maps slug → `{game, version}`. An
   earlier iteration re-derived versions by scraping them back out of survey logs, which is
   circular and breaks the moment a log is deleted.
3. **Load dependencies, score only the target.** See the section below — this is worth 2 points
   of apparent pass rate on its own.
   **Metadata alone is not enough; infer from the assets too.** Compat mods routinely reference
   a mod they never declare: `macaws-biomes-o-plenty` parents onto
   `mcwfences:block/parent/wall_inventory` while its `mods.toml` names only Biomes O' Plenty and
   addonslib, so **1,527 of its 2,047 items** were scored as failures for a dependency no index
   could know about. `dependencies.ts` samples ~150 models per jar and records every namespace
   they reference that the jar does not provide — that found all nine Macaw's mods and took the
   mod to **13 failures**. Cheap, too: a compat mod repeats the same few references throughout,
   so a sample finds them all.
4. **Bucket failures with ids redacted** (`/[\w.]+:[\w/.]+/g` → `<id>`), so one defect across
   400 items reads as one line. The bucket key is the renderer's own message, which is exactly
   why those messages must name what failed.

Era selection matters: `['1.20.1','1.20.4','1.21.1']` → `legacy` builtin pack, else `modern`.
`survey.ts` writes no shared state, so slice the catalog across eight processes for wall-clock;
jars cache, so re-running after a fix is compute-only.

### Always source the newest jar

Standing rule (also in memory): never diagnose an icon report against a stale cached jar.
Upstream frequently already fixed it. A `waystones:waystone` report earlier in this work was
diagnosed against a 1.21.1 jar; the current 26.2 release states the tints as data and needs
nothing from us.

## The single biggest methodological finding

**An addon mod surveyed without its dependency produces false failures, and at scale this
dominates the taxonomy.** Every one of these was verified by re-running with `two.ts`:

| pair | alone | paired |
| --- | ---: | ---: |
| betterend + bclib | 222 | 22 |
| mekanismadditions + mekanism | 113 | 2 |
| supplementaries + dye_depot | 51 | 2 |
| deep_aether + aether | 35 | 2 |
| rftools-utility + rftools-base | 26 | **0** |
| evilcraft + cyclops-core | 23 | 6 |
| createaddition + create | 3 | **0** |
| extended-ae + ae2 (earlier) | 27 | 1 |

That is 439 of 1,010 failures from seven pairs. `dramaticdoors` (83, a compat mod for other
mods' doors) and `oreganized` (16, needs `dye_depot`) are the same class, unverified.

**At 1,294 mods the effect is overwhelming and concentrated in the Create ecosystem.** The five
worst offenders in the top-1,200 sweep were all Create addons, and all went to (near) zero once
`create` was loaded alongside:

| pair | alone | paired |
| --- | ---: | ---: |
| create-encased + create | 715 | **0** |
| create-design-n-decor + create | 317 | **0** |
| create-framed + create | 144 | **0** |
| create-connected + create | 90 | 21 |
| interiors + create | 51 | **0** |

**1,296 of that sweep's 2,622 failures — half — were Create-addon artifacts alone.** Adjusted
for these plus the 168 LFS stubs below, the real rate stays around 98%.

**Two traps when doing this:**

1. A missing jar fails silently. My first deep-aether pairing reported an unchanged 35 because
   the Aether jar had been cleaned up and `two.ts` happily ran with one jar. Always check the
   jar exists before believing a null result.
2. Aether's own residual 2 failures needed a *third* mod (`nitrogen_internals`). Dependency
   chains are not one deep.

### Related: curated packs and absent namespaces

Surveying `mysticalagradditions` alone reports 54 phantom `mysticalagriculture:*_augment`
failures, because the addon jar legitimately declares that namespace and our curated tint pack
then contributes definitions whose models live only in the base mod.

I built a `NamespaceFilteredResourceManager` to gate the curated packs on jar-declared
namespaces, then **reverted it**: `namespaceSet` in `prepare.ts` is already derived only from
jars, and `discoverItems` only runs over `preparation.namespaces`, so the curated packs can
never introduce a namespace on their own. The filter fixed nothing observable. Recorded here so
nobody re-derives it.

## Fixes made (all generic, no new curated overrides)

### `src/models/loader.ts` — override-only models

`ModelJson.overrides` was *typed but never consumed*. A legacy model that is nothing but an
`overrides` list resolved to no geometry at all. An inventory stack reads every predicate as 0,
which is the state upstream resolves the list against, so pick the last override whose
predicates are all ≤ 0, else the first.

The guard has to be "nothing to draw" — **not** "no parent". My first attempt required
`builtinParent === null`, which missed Refined Storage's cards: they declare
`parent: "item/generated"` and then no layers. Correct condition is
`obj === undefined && elements.length === 0 && Object.keys(textures).length === 0`.

Closed: Blood Magic 8 → 0, plus the Refined Storage / Oreganized "Generated model without
layers" bucket.

### `src/models/loader.ts` — loader-nested models

`architects_palette:wrapped` holds a complete model under `wrapped_model`. Generalised: in the
unknown-loader tail, any value that is an object carrying `parent` or `elements` is unwrapped
and re-flattened. Requiring one of those two keys is what makes it safe — no `display` or
`textures` map has either. Architect's Palette 48 → 0.

### `src/items/definition.ts` — `base_model`

The unknown-type fallback honoured `model` only. Mods that layer a sprite over a plain model
name it `base_model` (`ae2:memory_card_identity`).

### `src/atlas/registry.ts` — underscore-joined trim namespaces

Already split `blue_skies-moonstone` on the hyphen. Caverns & Chasms writes
`caverns_and_chasms_copper_darker`, which no split can distinguish from a material name that
merely contains underscores. **Resolve it against the namespaces actually loaded** — that is
what makes the boundary unambiguous.

### Earlier in the session

- `src/render/pipeline.ts` `spriteFallback` — search for an exact leaf-name match under
  `items?/` then `blocks?/`, shortest path wins. Draconic Evolution 44 → 21.
- `src/items/discovery.ts` — `resolveItem` catches `InvalidItemDefinitionError` and falls back
  to the conventional `<ns>:item/<path>` model. This is what covered EnderIO's conduits.
- `src/render/entity-fallback.ts` — shield and shulker branches, mob-head layout gate.
- `src/textures/loader.ts` — `AnimatedTexture` sized `frameHeight` from `frameWidth`, so a
  64×32 sheet became 64×64 and every V coordinate shifted. This produced the mangled first
  render of `mekanism:atomic_disassembler`. Regression tests both ways.

### Trident geometry (target #1 closed)

`renderchest:item/trident` in both builtin packs, plus a `_trident`-suffixed branch in
`renderEntityFallback` — the shield pattern over again: shared geometry, the mod's own
`entity/trident` sheet rebound as `#texture`, vanilla's sheet as the fallback. Covers
`silentgear:trident` and any mod trident that reuses the vanilla model. `silentgear` 1 → 0.

The geometry replicates vanilla's `TridentModel` exactly — decompiled the obfuscated
`gpq.class` from the 1.21.8 client jar to confirm the five boxes and their `texOffs`, then
derived the six-face UVs from `ModelPart$Cube`'s bytecode rather than trusting memory. The
used texture region is only ~12×32 of the 32×32 sheet; the right-hand "thin trident" in the
art is never sampled.

Two things that look like our bugs and are not:

- **The vanilla trident icon is a flat sprite, not `builtin/entity`.** Both 1.20.1
  (`item/generated`, `layer0 = item/trident`) and 1.21.8+ (`items/trident.json` →
  `minecraft:select` → `minecraft:item/trident`) render the GUI icon from `item/trident.png`.
  The 3D entity model only draws in-hand/thrown. So "covers vanilla" in the target line
  above was optimistic — vanilla was never failing. The geometry earns its keep on mods.
- **The sheet path moved.** 1.21.8 keeps it at `entity/trident`; 26.1.2 nests it as
  `entity/trident/trident` (with `entity/trident/trident_riptide` for the spin state).
  `findTridentTexture` tries both, then the item name.

**The one genuinely new finding:** vanilla's trident shaft and prongs are 1px wide, and at icon
scale (0.4) that is sub-pixel. The nearest-neighbour rasterizer collapses the face's two
triangles onto one screen column, and — because the degenerate triangle never advances its
texture step — the *second* triangle overwrites the first with the neighbouring texture column,
which is transparent for the shaft. A 25px pole rendered as a 3px blob. The fix is a quality
floor: the trident branch renders at `max(quality, 4)` and box-downscales, which is what the
CLI does anyway at its default `--quality 2`. Any other 1px-thick entity model ported into the
builtin pack will need the same floor.

### Lootr cluster (partly closed)

The open question left above — are lootr's sheets whole skins? — is answered by the tool that
already exists: `coversSheet`'s opacity measure. `lootr:shulker` 39%, `lootr:chest` 40%,
`lootr:entity/loot_pot` 62.5%, against a vanilla shulker's 44% and Sophisticated Storage's trim
overlays at 0–5%. **All whole skins.** Two generic changes followed:

- **The lang file as the kind signal.** `lootr:lootr_inventory` is a *Loot Chest*; nothing in
  the id says so. `displayName()` reads `block.<ns>.<path>` / `item.<ns>.<path>` from `en_us`
  and the matchers test `name + '_' + displayName`. This is a *statement* of what the item is,
  not a guess from its name — strictly better than widening the matchers. Appended rather than
  substituted so the existing negative guards (`chestplate`) still see the whole string; a
  `shulker` + `!shell` guard was added for the same reason.
- **`findShulkerTexture` → `findEntityTexture(…, kind)`**, no longer requiring an `entity/`
  prefix (lootr files sheets straight under `textures/`), with `entity/` kept as a +1 tiebreak.

`lootr:decorated_pot` was attempted and **dropped**: `renderchest:item/decorated_pot` is only
the pot base, and vanilla composes base + sherd overlay (hence the `rc_pot_b_*` / `rc_pot_o_*`
model pairs the builtin pack ships). Binding a mod sheet to `#base` alone renders a flat slab —
and so does the branch with vanilla textures, so it is structural, not a texture problem. One
item is not worth replicating the pot composition machinery.

### A self-referencing override deadlocked the loader

Introduced by the override-redirect fix above, found by a watchdog killing a survey process at
5.5 GB. `armourers_workshop:item/skin` is override-only and its first entry names **itself** as
its unloaded state:

```json
{ "predicate": { "armourers_workshop:loading": 0.000 }, "model": "armourers_workshop:item/skin" }
```

`ModelLoader.load()` caches the in-flight promise under its key *before* resolution finishes, so
redirecting through `load()` made the model await itself — a permanent hang, surfacing as Node's
"Detected unsettled top-level await" and a process that grows until something kills it.

The redirect now calls `resolve()` directly rather than `load()`, skips a target equal to the
model being resolved, and carries a depth cap (4) so the same cycle spread across several models
also terminates. Going through `resolve()` is what matters: a two-model cycle would still hit
the cache and deadlock otherwise.

**Watch for this shape generally** — any resolution step that follows a reference by calling the
memoised entry point can deadlock on a self-reference, and memoising the *promise* is what turns
recursion into a hang instead of a stack overflow.

### Every GeckoLib model rendered inside-out

Spotted by eye ("those look a bit inside out"), and it had been true of every geo render since
the path was written.

`geoToFaces` mirrors X to convert Bedrock's axes to Java's. Negating one axis **reverses each
quad's winding**, which flips the normal `renderFace` culls on — so the cull kept the back faces
and discarded the front ones. Reversing the corner order after the mirror restores it.

Worth recording how it was confirmed, because eyeballing a Pokémon figurine could not settle it.
The test renders one cube with a **different solid colour per face** through both the element
renderer (golden-tested, therefore the reference) and the geo path, then reports which colours
survive:

| path | faces visible |
| --- | --- |
| element model (reference) | `east`, `north`, **`up`** |
| geo, as shipped | **`down`**, `east` — no `up` at all |
| geo, winding reversed | `north`, `west`, **`up`** |

A cube drawing its *underside* from a top-down isometric view is unambiguous. `east` vs `west`
differing is expected — that is the X mirror doing its job — so the assertion is the durable
part: the geo render must contain `up`, must not contain `down`, and must show as many faces as
the element render. That is now a test.

Visual confirmation afterwards: superbwarfare's AK renders as a clean rifle (barrel right,
magazine down, stock left) with no scrambled texture, and pokeblocks' applin basket now shows
its exterior rather than the checkered cloth *inside* it — which in hindsight is exactly what
"inside out" looked like.

### One item, 20 GB: the shading clone (never reproduce)

A full-corpus sweep took a workstation down. The cause was a **single item**,
`superbwarfare:ak_12_base`, whose render took one process from 1.9 GB to 20 GB.

`renderFace` shades by cloning the source texture and darkening the face's UV window, cached
per `(texture, tint, darkness, alpha, UV window)`. That is a good trade for block models, whose
faces reuse a handful of windows. It collapses completely on a detailed GeckoLib model:
superbwarfare's AK is 1,208 cubes → **6,136 faces, each with its own UV rect and its own float
shade level** (rotated cubes give continuously varying normals), so *nothing is ever reused* —
6,136 clones of a 1024×1024 texture at 33 MB each.

Three fixes were tried; two were wrong, and it is worth recording why:

1. **Drop the UV window from the cache key and darken the whole texture.** Equivalent for
   sampling, and it would collapse the key space — except `darkness` is already unique per face
   here, so it changed nothing. Reverted.
2. **Clone only the face's UV window and rebase the UVs into it.** Took the render from 21.5 GB
   to 152 MB and is the right shape of fix — but it is *not* pixel-identical. The rasterizer
   biases its texture cursor by 0.3 of a step and overdraws a leading pixel, so sampling
   legitimately lands outside the declared window, where upstream clamps against the whole
   image. Padding the crop by a pixel got `oak_fence` from 83 differing pixels down to 3, never
   to 0. **The golden tests against published renderchest output caught this**; pixel-identity
   is a contract and is not tradeable for a memory fix. Reverted.
3. **What shipped:** the cost is knowable before any allocation, so `renderGeo` computes
   `faces × texels × 32 bytes` and refuses above 512 MB, plus it samples the skin down to the
   resolution the geo *declares*. Mods routinely ship a declared 128×128 layout on a 512×512
   sheet (pokeblocks does); UVs are normalized by the declared size, so the extra resolution
   changes nothing about which texels a face covers while multiplying the shading cost 16×.

Result: `superb-warfare` peaks at ~1 GB instead of 20 GB, `pokeblocks` at ~500 MB, and every
golden test still passes. A refused model falls through to the item's own sprite — which for
those guns is the real inventory icon anyway.

**It came back twice more, in the element path.** Guarding `renderGeo` only covered geo models;
the cost is `faces × texels` and nothing about that is geo-specific:

- `yuushya:butterfly` — 104 elements (624 faces) on a **26-frame** 128×128 animation. 327 MB of
  clones per frame, 8.5 GB across the timeline. Fixed by deriving an affordable frame count from
  a clone budget and capping the timeline to it: frames are traded for memory, and one frame of
  a busy model still reads correctly at 16 pixels.
- `yuushya:fireflies` — 1,280 elements (**7,680 faces**) over five sheets, ~1 GB for a *single*
  frame, which no frame cap can reduce. Handled in `renderElementModelWith`, which both the
  single-frame and animated paths funnel through.

  Refusing outright was the first attempt and was wrong: it dropped ~70 items across the corpus
  including `ad_astra:tier_1_rover`, one of our own curated models that had been rendering
  correctly. **Face UVs are normalized**, so a smaller sheet is invisible to everything
  downstream — the fix shrinks the textures by `sqrt(budget / cost)` until the model fits.
  Detail beyond the icon's own 16 pixels was never going to survive anyway. Same trick as the
  geo path's declared-resolution downscale, generalized.

`yuushya-townscape` went 8,236 MB → **444 MB**, the rover renders again, and every golden test
still passes.

**The proper fix, now done.** Shading happens at sample time: the rasterizer applies tint,
darkness and alpha to each texel as it writes it (`shadeTexel` in `blend.ts`), rather than
against a pre-shaded copy of the texture. The three operations are pure per-pixel functions of
the original texel — tint over the whole sheet, darken and alpha over the 1px-expanded UV window
— so reproducing them at sample time is exactly equivalent, and the golden tests confirm it
pixel-for-pixel.

It is **not** unconditionally faster, which the benchmark caught. For a small sheet the old
clone wins: a block model's faces repeat the same few (window, light level) pairs, and there are
far more drawn pixels than texels. Shading per sample cost ~20% on the block-model and animated
benchmarks. So the clone survives as a **bounded** cache — 64 MB per render, with per-sample
shading as the always-correct fallback once the budget is spent. Both paths are pinned to
identical output by a test that renders one face each way.

| benchmark | before | after |
| --- | ---: | ---: |
| ten items, mixed model kinds | 11.97 hz | 12.33 hz |
| one many-element block model | 146.10 hz | 150.27 hz |
| one animated item, every frame | 16.48 hz | 17.08 hz |
| 300 overlapping faces at 128px | 239.78 hz | 253.29 hz |

All three earlier guards are **deleted** — the geo refusal, the animation frame budget and the
element-path texture downscale. They existed only to bound the clone, and each cost fidelity:
frames dropped from animations, sheets sampled below their authored resolution, whole items
refused. Full fidelity is restored and memory is better than it was *with* them:

| mod | original | with guards | sample-time shading |
| --- | ---: | ---: | ---: |
| superb-warfare | 20,296 MB | 1,039 MB | 563 MB |
| yuushya-townscape | 8,236 MB | 444 MB | 462 MB |
| pokeblocks | — | 502 MB | 379 MB |

The 6,136-face AK that once needed 21.5 GB now renders in 121 MB.

**Hunting technique that worked**, after two wrong guesses: an external watchdog
(`Get-Process node | where WorkingSet64 -gt N | Stop-Process`) to keep the machine alive, a
scanner that writes the current mod *and item* to a file **before** rendering it, and bisecting
the slug slice from the last name the survey managed to print. Guessing at the mechanism cost
far more time than measuring did.

Two smaller things the incident exposed:

- **`--max-old-space-size` does not bound this.** A process capped at 1536 MB still reached
  20 GB, because `Float64Array` backing stores are external memory, not old space. Do not rely
  on the flag as a safety net when fanning out surveys.
- **`prepareModResources` opened jars nobody could close.** Jars are opened `autoClose: false`
  and hold a descriptor plus an entry index each. `ModPreparation` now carries `close()`, and
  the survey reuses one vanilla tree per game version instead of reopening the client jar per
  mod. Measured, this was *not* the balloon (a 375-mod slice peaks ~550 MB either way) — but it
  is a real leak for any long-running consumer, and the measurement is the point: the obvious
  suspect was innocent.

### The debug-viewer trap (cost a wrong conclusion)

`FloatTexture.data` is a **`Float64Array` normalized [0,1]**, not bytes. A scratch viewer that
hands it to `sharp` as `raw: { channels: 4 }` produces washed-out near-white garbage for
*every* item. I did exactly that, and on the strength of it wrongly concluded the Ad Astra
vehicle port was mis-framed and backed it out.

**Always encode debug renders through `encodeIcon()` from `src/output/encode.ts`**, which calls
`toByteTexture` first. Re-rendered through it, all five Ad Astra vehicles were correct on the
first try.

More generally: when a render looks wrong for *every* item you throw at it, including ones
known to work, suspect the harness before the renderer. Rendering a known-good item
(`minecraft:decorated_pot`) as a control is the cheap check and is what eventually exposed both
this and the genuine pot-composition problem.

## Extractor and generator learnings

### Intermediary is the one mapping where class names do not survive

`scripts/mod-models/extract.ts` matches calls on **owner class + descriptor, never method
name**, because class names survive official (NeoForge 1.21+) and SRG (Forge 1.20.1) mappings.
Fabric/Yarn **intermediary** breaks that assumption: `CubeListBuilder` is `class_5606`.

Fixed with a `deintermediary()` pre-pass rewriting `class_NNNN` ids. The mapping is confirmed by
the descriptors the ids appear in, not from memory:

| id | class | confirming descriptor |
| --- | --- | --- |
| `class_630` | ModelPart | `.method_x(String) → class_630` (getChild) |
| `class_5603` | PartPose | `(FFF) → class_5603`, `(FFFFFF) → class_5603` |
| `class_5605` | CubeDeformation | `<init>(F)` |
| `class_5606` | CubeListBuilder | `(FFFFFFLclass_5605;) → class_5606` (addBox) |
| `class_5607` | LayerDefinition | `(Lclass_5609;II) → class_5607` |
| `class_5609` | MeshDefinition | `() → class_5610` (getRoot) |
| `class_5610` | PartDefinition | `(String, class_5606, class_5603)` (addOrReplaceChild) |

Ad Astra's `RocketModel` uses only `method_32090 (FFF)` = offset and `method_32091 (FFFFFF)` =
offsetAndRotation, so the `PartPose.offset`-vs-`rotation` descriptor collision that
`SRG_ROTATION` exists to resolve does not arise there. A future intermediary model that *does*
call three-arg `rotation` will need its id added to that set.

### `layerMethod`: one class, several layers

Ad Astra builds all four rocket tiers in one class. Parsed whole, that reads as a single
160-part table. `extractPartTables(jar, suffix, method)` narrows the javap listing to one
method's block first (25/45/52/38 parts per tier).

### A third model dialect: Citadel's `AdvancedModelBox`

`extract.ts` understands vanilla's `CubeListBuilder`/`PartDefinition` chain. Iceandfire (and
every other alexthe666 mod — alexsmobs, rats) builds models with **Citadel's
`AdvancedModelBox`** instead, which the extractor reads as zero parts. The dialect is regular
enough to support, and the mapping is:

| vanilla | Citadel |
| --- | --- |
| `ldc "<name>"` before `addOrReplaceChild` | `putfield <Name>:AdvancedModelBox` — the **field name** is the part name |
| `.texOffs(u, v)` | `new AdvancedModelBox(model, u, v)` — texOffs are **constructor args** |
| `.addBox(x,y,z,w,h,d, CubeDeformation)` | `.addBox(FFFFFFF)` — inflate is the 7th float |
| `PartPose.offset(x,y,z)` | `.setPos(FFF)` |
| `LayerDefinition.create(mesh, w, h)` | `putfield texWidth:I` / `texHeight:I` on the model |
| `addOrReplaceChild` parenting | `parent.addChild(child)` |

Not built: it is a real second parser, and each item still needs its own spec afterwards. Worth
doing only if a survey shows the Citadel mods are a large enough bucket.

### Generator bug: the part parent chain was never walked

`buildModel` composed `poseFor(part)` with `partTransform(part)` — the part's **own** offset and
rotation only. `Part.parent` was extracted and then unused. Every model shipped so far is flat
(all parts hang off the root, which is a `PartDefinition` and not itself a table part, so
`parent` is null throughout), so this had never surfaced. Ad Astra nests three deep
(`main` → `top` → `cube_r1`).

Fixed by composing the ancestry root-first. **Rebuilding produced byte-identical output for all
15 existing Mekanism and Botania models** — that diff is the regression proof, and is worth
re-running after any change to `generate.ts`.

### Pose composition semantics (do not re-derive)

`compose(a, b)` is `a ∘ b` — apply `b` first. `poseTransform(ops)` takes ops **outermost
first**, matching PoseStack: `mulPose(R); translate(t)` composes to `R ∘ T`, so a model point
maps `p → R(p + t)`. Confirmed to the decimal against Ad Astra's observed pivot.

Also: element `from`/`to` are pre-rotation (`box + C`), with the element's own `rotation.origin`
= `C`. So raw `from`/`to` bounds legitimately exceed the model's visual extent; do not use them
to sanity-check size.

## Deliberately not fixed

The governing rule all session: **a wrong icon reads as correct, which is worse than none.**

- **Spectrum's 43 mob heads.** Skins are 128×128. Being a power-of-two multiple of 64×64 does
  not make the unwrap vanilla's — these are custom Java skull models, so the vanilla head UV
  rect grabs arbitrary pixels. This is the confetti failure mode already backed out once
  (`egg_laying_wooly_pig_head`, `lizard_head`); the `HEAD_LAYOUTS` gate is doing its job.
- **Modern Industrialization's 68 cables/pipes.** Textures are generic (`electricity.png`,
  `fluid.png`); per-material colour is applied in code. No data to render from.
- **Framed Blocks (42), `enderio:painted_*` (12), `ae2:facade`.** Camouflage blocks with no
  inherent appearance.
- **Ad Astra's 5 vehicles — shipped, after a false alarm.** Initially backed out on the belief
  that they framed wrong; that was the broken debug viewer above, not the models. Re-rendered
  through `encodeIcon` they are all correct, and `ad-astra` is now **411 items, 0 failed**. The
  parent-chain fix is what made them right.
- **Ars Nouveau spell books.** No fuzzy geo matching.

## Mod-side quirks that are not our bug

- **thermal-expansion ships zero textures.** Its Modrinth jar (11.0.1, 1.20.1) contains no
  `assets/thermal/textures/` at all, while its models reference `thermal:block/dynamo_base` and
  `thermal:item/chiller_*`. Neither thermal-foundation nor cofh-core carries them. 31/31 items
  fail and there is nothing to fix on our side.
- **`aether:aerogel_stairs`/`_wall`** parent onto `nitrogen_internals:block/…`.
- **`oreganized` waxed concrete** parents onto `dye_depot:block/…`.
- **frostiful ships Git LFS pointer stubs instead of PNGs.** Every one of its 168 textures is a
  ~130-byte `version https://git-lfs.github.com/spec/v1` text file — the author published a jar
  built without LFS objects resolved. Nothing is renderable and nothing can be.

  It did expose a real gap on our side: `TextureLoader.loadAnimated` decoded without the
  `try`/`catch` wrap `decode()` has, so sharp's bare "Input buffer contains unsupported image
  format" surfaced 168 times naming no texture. Now wrapped as
  `Failed to decode texture <locator>: …`. **Any new sharp call on mod-supplied bytes needs
  that wrap** — an unattributable error is the taxonomy's masking bug in miniature.
- **Cinderscapes' 87 trim permutations ship no palettes.** Unlike Caverns & Chasms, the jar has
  no `trims/color_palettes/` at all — `CinderscapesArmorTrimAssets` registers them in code, so
  there is nothing for `paletted_permutations` to synthesize from. The namespace-matching fix
  above does not and cannot help here.

## Failure taxonomy at 189 mods

Aggregated across the consolidated run, before the last two fixes:

| count | bucket |
| ---: | --- |
| 466 | Model not found |
| 236 | Missing texture |
| 140 | No drawable geometry (code-rendered model) |
| 119 | Unsupported builtin parent builtin/entity |
| 23 | Generated model without layers |
| 13 | Unknown item model type |
| 13 | Every face texture unresolved |

The top two are overwhelmingly cross-mod references. The `builtin/entity` bucket is the largest
genuinely-addressable one and is all Java entity models — Ad Astra's vehicles, Iron Chests,
Ars Nouveau's spell books, `silentgear:trident`, `citadel:*_item`, Iceandfire's 23. Each needs a
per-item spec in `scripts/mod-models/build.ts`, not a generic fix.

`silentgear:trident` is worth calling out: it is vanilla-trident-shaped, but **the builtin pack
ships no trident geometry** (`assets/builtin-legacy/minecraft/models/item/` has chest, conduit,
heads, decorated_pot, shield, banners, beds, shulkers, and the rc_* trim/pot/potion sets — no
trident). Adding one would cover vanilla and every mod trident at once, the same way the shield
branch does.

## Next targets, in order of value

1. ~~Trident geometry in the builtin pack~~ — done.
2. ~~Ad Astra vehicle port~~ — done; ad-astra is at 0 failed.
3. ~~Lootr shulker/chest~~ — done via the lang-name signal. The pot remains, and needs base +
   sherd-overlay composition rather than a single model.
4. Iron Chests / Iceandfire (23) `builtin/entity` ports — the extractor now handles
   intermediary and nested models, so these should be spec work only.
5. ~~Dependency-aware surveying~~ — built; `scripts/coverage/dependencies.ts` reads
   `fabric.mod.json` / `mods.toml` `depends` from the cached jars and `survey.ts` auto-pairs.
   Worth +2.05 points of measured accuracy.
6. The remaining 1,903 failures are mostly **not** rendermite defects. Ranked:
   676 `builtin/entity` (Java-rendered, needs per-item extractor specs — `pokeblocks` alone is
   344 figurines that survive pairing with cobblemon), 482 missing textures (largely code-driven
   or genuine mod bugs), 246 models not found, 217 code-rendered geometry, 168 frostiful LFS
   stubs, 77 Draconic Evolution crystals drawn from `textures/models/crystal_base.png` by code
   with no per-item sprite to fall back to. Spot-checks of the long tail keep landing on mod
   bugs: `placeable_food` references an empty texture path (`placeable_food:block/`) and a
   vanilla model that does not exist (`minecraft:breadloaf`).

   In other words the cheap generic wins are done. Further progress means Java model extraction
   (the `builtin/entity` bucket), which is per-item spec work.
