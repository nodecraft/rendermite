# rendermite design

Node.js/TypeScript rewrite of [aternos/renderchest](https://github.com/aternosorg/renderchest) (PHP). Goals, in priority order:

1. **Pixel fidelity** — near-identical output to renderchest for everything it renders today.
2. **One codebase, every version** — the PHP tool needs a different tag per Minecraft era
   (v2.5.2 for ≤1.20.4 + modded, v2.10.1 for 1.20.5–1.21.3, v5.1.0+ for 1.21.4 `items/`
   definitions). This tool detects the asset format and handles every era in one binary,
   including the pre-1.8 and pre-1.6 preparation the ui pipeline bolts on outside renderchest.
3. **Modded support** — Forge/NeoForge/Fabric model formats, synthesized item models, and the
   long tail of weird formats catalogued from the 61k-item modded run in Nodecraft's internal `ui` repo.
4. **Reliability** — no silent item drops. renderchest loses ~5% of modded items to worker
   deaths while logging success and exiting 0. Every item here either renders or is reported,
   and the run summary counts files, not log lines.
5. **Speed** — in-process worker threads over raw RGBA buffers, sharp (libvips) for encode.
   No Docker requirement, no PHP socket workers, no bind-mount penalty.
6. **Output** — optimized PNG + WebP (+ AVIF behind a flag), the renderchest-compatible CSS +
   JSON library contract nodepanel already consumes, without the post-processing fixes the ui
   pipeline applies today (url rebasing, minification, pruning).

## Research corpus (docs/research/)

- `renderchest-spec.md` — full master-branch pipeline spec (projection, rasterizer, lighting,
  tinting, atlas sources, CSS generators, constants). The implementation contract.
- `version-history.md` — tag→MC mapping; which renderer produced which corpus era;
  pixel-relevant differences between tags; parity strategy.
- `lighting-v5.1.0.md` — the legacy light model the published corpus was rendered with.
- `ui-pipeline-learnings.md` — operational learnings from the ui repo's pipeline (asset prep
  per era, modded sourcing/synthesis, output contract, optimization settings).
- `css-contract.md` — verbatim CSS structure read off a live published stylesheet.

Reference data:
- Upstream source: a local clone of [aternos/renderchest](https://github.com/aternosorg/renderchest) (all tags).
- Published renderchest output for pixel comparison: `https://mc-assets.nodecraft.com/icons/<version>/…`
  (losslessly-optimized; every stable release back to 1.0; modded under `icons/modded/`).
- Mod jars + packs: the internal `ui` repo's `.minecraft-icons/{modjars,packs}/` corpus (local only, license-restricted).
- Local fixture: `.work/fixtures/1.21.8/` (extracted client jar assets).

## Architecture

```
src/
  resources/   locator (ns:path parsing), managers (folder, layered; jar later)
  models/      model JSON types, ModelLoader (parent-chain flattening, texture #refs,
               gui_light capture semantics, salvageJson for mod junk)
  textures/    TextureLoader (sharp PNG decode → RGBA, mcmeta frame cropping)
  render/      vector (Mat4/Vec3, display matrix, item transforms)
               blend (source-over, red-channel tint, darken — upstream-exact)
               geometry (element corners, auto-UVs, element rotation)
               rasterizer (scanline triangles, 0.3 bias, overdraw, truncation sampling)
               face (cull, project, tint, darken, rasterize)
               compose (per-pixel depth sort + source-over)
               lighting (modern two-dir diffuse + legacy single-dir profiles)
               renderer (generated 2D path, element 3D path, point/box resampling)
  items/       (next) item discovery across eras + 1.21.4 item-definition evaluation
  atlas/       (next) directory/single/unstitch/paletted_permutations sources
  dynamic/     (next) _armor_trims, _leather_armor, _decorated_pot, _crossbow
  output/      (next) encode via sharp (PNG/WebP/AVIF), stylesheet + item library
  versions/    (next) era detection, legacy reshaping, donor geometry (port from ui lib.ts)
  mods/        (next) loader model flattening, synthesized item models (port from ui lib.ts)
```

### Key decisions

- **Rendering algorithms are upstream-exact**, including deliberate quirks (rounded screen
  coords, red-channel tint luminance, alpha inflation on translucent texels, 0.3 scanline
  bias, depth-0 overdraw band, per-pixel painter's compositing). Upstream *bugs* we do NOT
  reproduce by default but may need behind a compat flag for golden tests: GrassTinter corner
  sample, unstitch height-from-width, rc-enchantment.webp misformat.
- **Lighting profiles**: `modern` (master two-direction diffuse — default) and `legacy`
  (v2.5.2–v5.1.0 single-direction, inactive front) for corpus parity. See
  `docs/research/lighting-v5.1.0.md`.
- **Float64 RGBA in [0,1]** throughout the pipeline (Imagick works on normalized floats);
  quantize to 8-bit only at encode.
- **Item discovery is era-adaptive** (unlike any single renderchest tag): `items/*.json`
  definitions when present, `models/item/*.json` scan otherwise, both unioned with dynamic
  and builtin items.
- Builtin pack: port renderchest's `builtin/` (entity models, mobheads, placeholders,
  internal split layers) — it shadows user assets for file lookups; atlas sources are
  priority-reversed (last root wins). Vendor as repo assets with attribution (MIT).
- Concurrency: worker_threads with batched item queues; caches (models, textures) shared
  per worker. Failures are per-item, collected, and reported in the run summary — never
  silent, never fatal to the run.

## Version support matrix

| Era | Asset format | Handling |
| --- | --- | --- |
| 1.21.4+ | `items/` definitions, palette permutations (`textures/palettes/` in newest) | native |
| 1.9–1.21.3 | `models/item/*.json` discovery | native (scan) |
| 1.8.x | JSON models, no `models/item/generated.json` | synthesize `generated.json` |
| 1.6–1.7.x | flat textures only | donor geometry layering (1.12.2 over 1.8.9), textures stay the target's |
| 1.5.x | root-level `textures/`, old names | pixel-match rename against 1.6.4 reference art (tolerance 40) |
| ≤1.4.7 | stitched `terrain.png` + `gui/items.png` | slice 16-col grid, pixel-match tiles, drop unmatched |

Plus per-era shims from the ui pipeline: synthesized `atlases/blocks.json` below 1.19.3
(without it nothing resolves), glint rename below 1.19.3, pre-1.13 plural texture dirs.

## Mod support

- `salvageJson` (done) — Gson-tolerated trailing junk.
- Loader-model flattening: `loader` key → `perspectives.gui` → `base` → `childModel` →
  first `children` → bucket heuristic; OBJ left to the OBJ renderer (stretch goal).
- `synthesizeItemModels` port: lang-declared filter, item-sprite-wins collisions, face-suffix
  and UV-atlas skips, cube_bottom_top/cube_all fallbacks.
- Per-namespace synthesized atlases; loader namespaces excluded; jar safety (reject archives
  with traversal entries).
- HD/non-square textures: generated path point-resizes to square (upstream-compatible);
  animation strips detected by mcmeta or aspect.

## Output contract

- `items/<ns>/<item>.png|webp` at 64px (size/quality configurable like upstream).
- `rc-minecraft-64.css` per `docs/research/css-contract.md` (compound selectors, tint custom
  properties, glint `:after`, `@media (min-resolution: 1dpi)` WebP upgrade block), with a
  configurable URL prefix so published sheets need no rebasing, and sanitized selectors so
  junk texture names can't break the sheet.
- `rc-minecraft.json` — flat array of rendered ids (+ a richer sidecar with failure detail).
- AVIF: behind a flag; measure size/time before defaulting on (icons are tiny; AVIF's wins
  may not materialize at 64px).
- Optimization defaults match the ui pipeline: PNG `compressionLevel 9, effort 10, palette`,
  WebP lossless effort 6, only keeping strictly smaller results.

## Performance plan

- Rasterization/composite in TS over typed arrays; the per-pixel composite is the hot spot —
  optimize after parity (e.g. skip fully-transparent face rows, precompute depth order for
  the common single-opaque-face case).
- Texture decode/cache per worker; models cached by locator.
- Benchmark target: beat renderchest's ~1,100 items/min (5 shards, docker) single-process.

## Testing

Fully self-contained: no fixture references a developer machine.

- Unit tests per module (locator, managers, model loader, salvage, geometry, blend math,
  item styles, animation, encode).
- Vanilla jars download at test time via mcversions.net (vitest globalSetup prefetches all
  24 versions into `.work/fixtures/`); synthetic mod jars build from committed declarations
  in `test/fixtures/mods.ts` (cross-jar deps, every loader branch, OBJ+MTL, geo.json,
  junk JSON, modern definitions, 1.7.10 texture-only).
- Version matrix: 18 releases, 1.2.5 → 26.2, coverage floors vs the published corpus lists
  plus tint and must-render assertions.
- Real mods download from Modrinth at test time (create, sophisticated pair, bartering
  station, trading post, immersive engineering); `RENDERCHEST_SKIP_ONLINE=1` skips offline.
  `RENDERCHEST_MODJARS` points an extra env-gated suite at local CurseForge-only jars.
- Golden pixel tests compare against a local docker render of real renderchest v5.1.0
  (`.work/golden/1.21.8-docker/`) — the published corpus is NOT pixel ground truth (its
  PNGs are palette-quantized and its WebPs lossy).
- `scripts/sweep-mods.ts`: broad Modrinth coverage sweep with failure-class rollup.

## Benchmark (same machine, same 1.21.8 assets, 64px q2, png+webp)

| | wall-clock | items written | silent drops | items/min |
| --- | --- | --- | --- | --- |
| renderchest v5.1.0 (docker, 8 PHP workers) | 210s | 1,573 (claimed 1,606) | 33 | ~449 |
| rendermite (one Node process, pool 8) | 22.9s | 2,065 | 0 | ~5,410 |

9.2× faster with 29% more items rendered; the PHP run demonstrated the silent-drop failure
mode live (33 items logged as rendered, never written).
