# Mod rendering failure taxonomy

Extracted 2026-08-12 from the internal `ui` repo's `.minecraft-icons/` analysis scripts, logs, and data.
The corpus: 5,114 namespaces layered, 4,086 with item content, 430,890 real item models +
5,211 synthesized, 419,332 rendered/merged, **74,964 CSS rules pointing at icons never
written (~8% silent loss)**.

## The masking bug (never reproduce)

Any per-item exception in a renderchest worker gets wrapped in an ExceptionResponse that
transitively holds a Closure; PHP fatals serializing it (`Serialization of 'Closure' is not
allowed`, taskmaster Socket.php:46), the socket dies, and the real error is destroyed.
27,286 `Failed to render item` lines; 9,824 say only `Could not read from socket`; 17,462
have no reason at all (orphaned queue items). renderchest then logs `Rendered item N/M`
for the same item, writes its CSS rule, and exits 0.

**Rewrite requirement: structured per-item errors that survive the worker boundary; never
emit a success record for a failed item; count files, not log lines.**

## Failure classes

1. **Missing textures** — ~half were paths held in some jar: mods add to the `minecraft`
   namespace, so mod-provided `assets/minecraft/textures/` must be layered beneath real
   vanilla. Verdicts: inJarWeHold (fixable), inNoJar (cross-mod deps; closed by dependency
   chasing — final absent list was just `["jaopca"]`), vanillaNonexistent (mod bug).
2. **Missing/unresolvable parents** — top offenders:
   - Conquest Reforged (4,232): bare `parent: "block/parent_beamarch"` resolving to a
     nonexistent minecraft: path.
   - heralds_luna (4,893): Blockbench banners with relative sibling parents
     (`"parent": "flag"` — no directory, no namespace), `format_version`, numeric texture
     keys (`"0"`, `"1"`), models under `models/custom/`.
3. **builtin/* chains** — no drawable geometry; flat-sprite fallback check (`hasFlatTexture`).
   Also: renderchest's own builtin pack rendering block entities that postdate the target
   version (prune-on-retry, 134/253 pruned for 1.8.x).
4. **Animated textures** — strips 16×48 to 16×560 (powah). Mismatched layer sizes crashed
   ColorBlender (`ImagickPixel null` on a 16×16 × 16×560 blend). **Normalize every layer to
   frame 0 at a common resolution before tint/blend.** Some mods ship frames as separate
   models (`*_flipbook.00` … — 1,028 rules dropped).
5. **Custom loader models → black icons** — 1,793 models across ~200 namespaces rendered as
   black squares (loader present + nothing drawable up the parent chain; `item/generated`,
   `item/handheld`, `block/block`, `builtin/*` count as empty shells). Worse than failing:
   the item counts as having an icon. Flattening rewrote 2,836; 2,823 left (mostly obj/code).
6. **OBJ models** — 158 item models (forge:obj 124, neoforge:obj 24, ie_obj 9, +1). The
   .obj/.mtl files ARE in the tree — an OBJ+MTL parser reclaims all of them. Mods:
   immersiveengineering/petroleum/technology, advgenerators, enderio, computercraft, littletiles.
7. **Malformed JSON** — 10,529 files with trailing junk (Gson tolerates); 310 unsalvageable.
8. **Synthesis name collisions** — 298 item-vs-block texture name collisions; one model per
   name, item sprite wins, deterministic.
9. **Wrong-but-rendered synthesized cubes** — texture wrapped on a cube with no blockstate
   evidence; `<id>_base`-only block entities. Skip rules in synthesizeItemModels.
10. **Invented items** — textures that aren't items (phonos: 102 icons for 29 real ids).
    Filter by lang-file-declared ids.
11. **Runtime-generated trim textures** — namespaces layering
    `minecraft:trims/items/<piece>_trim_<material>` (grayscale bases + palettes) rendered
    nothing under v2.5.2: advancednetherite (184), create_trimmed (288), better_sword_trims,
    bedspreads. **Implementing paletted_permutations makes this whole class renderable.**
12. **1.21.4+ items/ definitions in mods** — invisible to v2.5.2; needed a separate v5 pass.
    One era-adaptive discovery pass removes the split.
13. **Entity-model/GeckoLib items** — geckolib3, mowziesmobs, iceandfire, epicfight,
    touhou_little_maid: .geo.json never read; guaranteed misses. (Player heads similarly
    need runtime skin rendering.)
14. **CTM/emissive/optifine** — `textures/optifine/`, `_e` siblings, `.properties`: ignore,
    don't mistake for items. Low impact for icons.

## Loader model census (black-icon subset)

forge/neoforge separate_transforms 583+8+6 (perspectives.gui IS the icon view),
fluid_container 167+75, forge:composite 146 (children map, first child), obj 124+24,
bucket 22; codechickenlib:class 238 ("instantiate this Java class"), tconstruct (fluid 71,
tool 49, material 33), botania:floating_flower 68, chiselsandbits 21+, 60+ distinct others.
Flattening priority: perspectives.gui → base → childModel → children[0] →
/fluid_container|bucket/i → item/bucket; /obj$/i left alone.
Also honored in the wild: forge `display.thirdperson` transforms (only gui matters),
`render_type: translucent`, numeric texture keys, `forge_marker: 1` blockstates (1.12.2).
Fabric ships vanilla JSON models — no loader format.

## Pre-1.8 hybrid experiments (1.7.10)

Donor comparison: 1.8.9 alone = 516 item wrappers (flat renders for ~200 blocks);
1.12.2 alone = 717 but loses era-only names; **both layered oldest→newest won** (721
wrappers, 1,312 block models) → `GEOMETRY_DONOR_VERSIONS = ['1.8.9','1.12.2']`.
Blockers: missing `models/item/generated.json` fatals stylesheet generation AFTER all
items render; v1.x renderchest unusable. Pre-1.8 mod textures use PLURAL dirs
(`textures/items/`, `textures/blocks/`) — a modern resolver finds nothing.

## Licensing/sourcing

- CurseForge API has NO licence field (only allowModDistribution); Modrinth is the only
  SPDX source. 20 mods deny redistribution (distribution-denied.json) — excluded.
- Of 4,229 sourced: ~26% MIT-family, ~23% All-Rights-Reserved (5 spellings), 17% nothing
  stated in jar. SPDX normalization + case-insensitive LicenseRef dedupe needed.
- Excluded categories: library, optimization; also client-only (`server_side: unsupported`).
  Jar content is the only authority on whether a mod has items.
- Jar safety: any entry absolute/drive-letter/`..` → discard whole jar.

## Coverage reality check

Of 8,299 "uncovered" pack-referenced mods, only ~2,150 were real icon gaps; the top 900 by
pack count yielded 2. The head of any download ranking is libraries/client mods; real
content lives in the tail.

## Weird namespaces and names

- Duplicate hyphen/underscore spellings of the same mod (projectred-* vs projectred_*),
  each with its own icons.
- Hyphens (illegal but shipped): aa4-atlas, ducky-periphs, iron-jetpacks…
- Namespace starting with a digit: 1_splatus.
- CamelCase 1.7.10 ids colliding case-insensitively (LBCargoLavaBoat / dimensionalCore).
- Item names breaking CSS: dots, spaces, `- Copy`, parentheses, semicolons
  (`dannys_expansion_ho;ly_wreath`), version strings. Sanitize output identifiers
  independently of asset identifiers.
- Never parse `.rc-<ns>_<item>` compound keys — keep namespace and item separate fields.
- `minecraft:empty`/`unknown` placeholders leak into every shard's output — filter output
  against requested namespaces.

## Operational learnings for the rewrite

- No Docker: kills the bind-mount penalty (14.5×–80×) and the volume staging dance.
- Bound memory per work unit (~1,000 items per PHP process ≈ 1 GB); our workers should
  stream and stay flat. Renderer hangs = dead worker + undrained queue; stylesheet written
  last means a hang loses everything — write incrementally.
- Write manifests last; verify over the network resolving urls the way a browser does.
- Per-item set manifests (`sets/<ns>.json`) exist so consumers can distinguish "mod has
  icons" from "item has an icon" — publish them; the consumer gap is known.
