# Mod coverage campaign

Worked 2026-08-15 on `feat/more-mods`. Grew the surveyed corpus from ~30 mods / ~16.5k items to
**220 mods / 55,574 items** and closed most of the failure classes that survey exposed. This
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
| 220 mods (final) | 55,574 | 1,068 | 98.08% |

(The two small corpora differ by the mods that 404'd or shipped no textures, so compare rates
rather than counts.)

**The raw rate falls as the corpus grows, and that is mostly an artifact, not a regression.**
See below. Adjusted for dependency artifacts the real figure is ~98.9%.

Mods measured at exactly zero failures include: create, chipped, rechiseled (3,739 items),
nuclearcraft (1,575), aerial-hell (1,406), oh-the-biomes-weve-gone (938), quark (838),
regions-unexplored (730), stoneworks (572), simply-swords, storagedrawers, cc-tweaked,
extreme-reactors, thermal-cultivation, thermal-dynamics, tetra, and all nine Macaw's mods.

## Method

A dev-time harness under `.work/cov/` (gitignored — rebuild from this description):

- `survey.ts <slug…>` — for each Modrinth slug, pick the newest release whose `game_versions`
  intersect a supported list and whose `loaders` include neoforge/forge/fabric, download to
  `.work/fixtures/modrinth/cov-<slug>.jar`, `prepareModResources` it against the matching
  vanilla jar, then `renderFramesWithFallback` every discovered item. Failures are bucketed by
  message with ids redacted (`/[\w.]+:[\w/.]+/g` → `<id>`) so the taxonomy aggregates.
- `two.ts <vanilla> <era> <jar…>` — same, but several jars in one tree. This is the dependency-
  pairing tool and the single most important one.
- `probe.ts <jar> <vanilla> <era> <id…>` — unredacted error for specific ids.

Era selection matters: `['1.20.1','1.20.4','1.21.1']` → `legacy` builtin pack, else `modern`.

Run four `survey.ts` processes in parallel over a split slug list; jars cache, so re-running
after a fix is compute-only.

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
- **Ad Astra's 5 vehicles.** Built and rendered; geometry extraction verified correct (absolute
  extent 6.75 blocks, matching a tier-1 rocket) and pose composition verified correct, but the
  rendered icons still frame wrong. Specs and generated assets removed. The narrow open
  question: how the jar's authored `display.gui` (`scale 0.2`,
  `translation [-0.5, -4.8, 0]`) is meant to frame a 108-pixel model. The extractor and
  generator work above is kept because it is independently correct and tested.
- **Ars Nouveau spell books.** No fuzzy geo matching.

## Mod-side quirks that are not our bug

- **thermal-expansion ships zero textures.** Its Modrinth jar (11.0.1, 1.20.1) contains no
  `assets/thermal/textures/` at all, while its models reference `thermal:block/dynamo_base` and
  `thermal:item/chiller_*`. Neither thermal-foundation nor cofh-core carries them. 31/31 items
  fail and there is nothing to fix on our side.
- **`aether:aerogel_stairs`/`_wall`** parent onto `nitrogen_internals:block/…`.
- **`oreganized` waxed concrete** parents onto `dye_depot:block/…`.

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

1. Trident geometry in the builtin pack (covers vanilla + mod tridents via one branch).
2. Finish the Ad Astra vehicle port — the framing question above is the only blocker, and the
   extractor now handles intermediary and nested models.
3. Iron Chests / Iceandfire `builtin/entity` ports.
4. Dependency-aware surveying: teach `survey.ts` to read `fabric.mod.json` / `mods.toml`
   `depends` and auto-pair, which would make the raw pass rate meaningful without hand-pairing.
