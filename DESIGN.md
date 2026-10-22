# rendermite design

Node.js/TypeScript rewrite of [aternos/renderchest](https://github.com/aternosorg/renderchest) (PHP). Goals, in priority order:

1. **Pixel fidelity**: near-identical output to renderchest for everything it renders.
2. **One codebase, every version**: renderchest needs a different tag per Minecraft era
   (v2.5.2 for ≤1.20.4 + modded, v2.10.1 for 1.20.5–1.21.3, v5.1.0+ for 1.21.4 `items/`
   definitions). rendermite detects the asset format and handles every era in one binary,
   including the pre-1.8 and pre-1.6 preparation those old versions need.
3. **Modded support**: Forge/NeoForge/Fabric model formats, synthesized item models, and the
   long tail of unusual formats real mod jars ship.
4. **Reliability**: no silent item drops. Every item either renders or is reported in the
   failure sidecar, and the run summary counts files written, not log lines.
5. **Speed**: in-process worker threads over raw RGBA buffers, sharp (libvips) for encode.
   No Docker requirement and no PHP socket workers.
6. **Output**: optimized PNG + WebP (+ AVIF behind a flag) and the renderchest-compatible CSS +
   JSON library, with URL prefixing and minification built in so no post-processing is needed.

## Reference docs

- [`docs/renderchest-spec.md`](docs/renderchest-spec.md): renderchest's pipeline (projection,
  rasterizer, lighting, tinting, atlas sources, CSS generators, constants). The implementation
  contract.
- [`docs/renderchest-compat.md`](docs/renderchest-compat.md): which renderchest tag covers which
  Minecraft versions, pixel-relevant differences between tags, and the legacy lighting model.
- [`docs/css-output.md`](docs/css-output.md): the structure of the generated stylesheet.
- [`docs/mod-coverage.md`](docs/mod-coverage.md): how mod coverage is measured against real jars.
- [`docs/block-pack-export.md`](docs/block-pack-export.md), [`docs/block-light.md`](docs/block-light.md),
  [`docs/entity-geometry.md`](docs/entity-geometry.md): the block pack output mode.

## Second output mode: block packs

`rendermite blocks` emits block geometry and textures as data (atlas + JSON) for a GPU
renderer, rather than rendered icons. Java Edition, 1.13 and up. Everything above the
rasterizer is reused unchanged; the new pieces are a real blockstate evaluator, an atlas
packer, and the emit. See [`docs/block-pack-export.md`](docs/block-pack-export.md).

## Architecture

```
src/
  resources/   locator (ns:path parsing), managers (folder, layered, jar), caching,
               worker-transferable descriptors
  models/      model JSON types, ModelLoader (parent-chain flattening, texture #refs,
               gui_light capture semantics, salvageJson for mod junk)
  textures/    TextureLoader (sharp PNG decode → RGBA, mcmeta frame cropping)
  render/      vector (Mat4/Vec3, display matrix, item transforms)
               blend (source-over, red-channel tint, darken; upstream-exact)
               geometry (element corners, auto-UVs, element rotation)
               rasterizer (scanline triangles, 0.3 bias, overdraw, truncation sampling)
               face (cull, project, tint, darken, rasterize)
               compose (per-pixel depth sort + source-over)
               lighting (modern two-dir diffuse + legacy single-dir profiles)
               renderer (generated 2D path, element 3D path, point/box resampling)
               obj, geo (OBJ+MTL and GeckoLib geometry), entity-fallback, pipeline
  items/       item discovery across eras + 1.21.4 item-definition evaluation
  atlas/       directory/single/unstitch/paletted_permutations sources
  dynamic/     _armor_trims, _leather_armor, _decorated_pot, _crossbow
  output/      encode via sharp (PNG/WebP/AVIF/GIF), stylesheet + item library, minify
  versions/    client jar download, era detection, legacy reshaping, donor geometry
  mods/        loader model flattening, synthesized item models, tint and model overrides
  entities/    class file reader and bytecode interpreter for entity model geometry
  workers/     worker pool and render worker
  blocks/      block pack export: blockstate-eval (variants/multipart/weights),
               atlas-pack (shelf packer, edge-extended padding), obj-mesh (OBJ
               loader geometry as triangles), tints (vanilla BlockColors table +
               plains colormap sampling), light, behaviour, export (the emit)
```

### Key decisions

- **Rendering algorithms are upstream-exact**, including deliberate quirks (rounded screen
  coords, red-channel tint luminance, alpha inflation on translucent texels, 0.3 scanline
  bias, depth-0 overdraw band, per-pixel painter's compositing). Known upstream bugs are not
  reproduced: GrassTinter corner sample, unstitch height-from-width, rc-enchantment.webp
  format.
- **Lighting profiles**: `modern` (renderchest master's two-direction diffuse, the default) and
  `legacy` (v2.5.2–v5.1.0 single-direction, inactive front) for parity with icons rendered
  by those tags. See [`docs/renderchest-compat.md`](docs/renderchest-compat.md).
- **Float64 RGBA in [0,1]** throughout the pipeline (Imagick works on normalized floats);
  quantize to 8-bit only at encode.
- **Item discovery is era-adaptive** (unlike any single renderchest tag): `items/*.json`
  definitions when present, `models/item/*.json` scan otherwise, both unioned with dynamic
  and builtin items.
- **Builtin pack** vendored from renderchest (MIT, see [`assets/README.md`](assets/README.md)):
  entity models, mobheads, placeholders, internal split layers. It shadows user assets for
  file lookups; atlas sources are priority-reversed (last root wins).
- **Concurrency**: worker_threads with batched item queues; caches (models, textures) shared
  per worker. Failures are per-item, collected, and reported in the run summary: never
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

Plus per-era shims: synthesized `atlases/blocks.json` below 1.19.3 (without it nothing
resolves), glint rename below 1.19.3, pre-1.13 plural texture dirs.

## Mod support

- `salvageJson`: tolerates the trailing junk Gson accepts and strict parsers reject.
- Loader-model flattening: `loader` key → `perspectives.gui` → `base` → `childModel` →
  first `children` → bucket heuristic; OBJ loaders go to the OBJ renderer.
- Synthesized item models for texture-only jars (`src/mods/synthesize.ts`): lang-declared
  filter, item-sprite-wins collisions, face-suffix and UV-atlas skips, cube_bottom_top/cube_all
  fallbacks.
- Per-namespace synthesized atlases; loader namespaces excluded; jar safety (reject archives
  with traversal entries).
- Tint sourcing for code-registered colors (`src/mods/tints.ts`): a mod's 1.21.4+ release
  states its tints as data, so a newer jar of the same mod is an authoritative donor for its
  older jars, the same trick donor geometry plays for pre-1.8 versions. Harvested overrides
  are ordinary item definitions layered below the real tree; the residue no release ever
  turned into data is curated in `assets/mod-tints/` and layered above the jars.
- Curated geometry for items drawn only in code lives in `assets/mod-models/`, generated from
  the mod's own bytecode.
- HD/non-square textures: generated path point-resizes to square (upstream-compatible);
  animation strips detected by mcmeta or aspect.

## Output contract

- `items/<ns>/<item>.png|webp` at 64px (size/quality configurable like upstream).
- `<prefix>enchantment.png|webp|avif` for every glint format referenced by the stylesheet.
- `<prefix><ns>-<size>.css` per [`docs/css-output.md`](docs/css-output.md) (compound selectors,
  tint custom properties, glint `:after`, `@media (min-resolution: 1dpi)` WebP upgrade block),
  with a configurable URL prefix so published sheets need no rebasing, and sanitized selectors
  so junk texture names can't break the sheet.
- `<prefix><ns>.json`: flat array of rendered ids (+ a failures sidecar with per-item detail).
- AVIF is opt-in (`--avif` or `--format avif`); WebP stays the default.
- Encode defaults: PNG `compressionLevel 9, effort 10`, palette only when provably lossless,
  WebP lossless, keeping only strictly smaller results.

## Performance

- Rasterization/composite in TS over typed arrays. The per-pixel composite was the hot spot
  (18% of CPU); it now indexes faces by bounding box and tracks the paint order as a rank per
  face instead of re-sorting every face at every pixel.
- One scratch color/depth buffer per model render with a rasterizer-tracked dirty rect,
  rather than an image-sized pair per face.
- Face shading (clone + tint + darken) memoized per texture/tint/light/UV window; animated
  models reuse geometry, matrices, paint order and any face whose texture did not change
  that tick. **The memo is bounded by bytes and every user has a per-sample fallback; see
  below.**
- Texture decode and models cached per worker, both LRU-bounded (textures by decoded bytes)
  so a run across thousands of namespaces does not grow without limit.
- Client jars index with their central directory read in one go; per-record reads cost more
  than a second of startup on a 26k-entry jar.
- Items render across worker threads when the resource tree can describe itself
  (`src/resources/descriptor.ts`); otherwise the same `ItemPipeline` runs in-process.
- Animated timelines are bounded: a combined cycle beyond the frame cap is sampled evenly
  across its whole length, never truncated, and identical neighbours coalesce.

### Never pre-shade a texture without a budget

Shading a face by cloning its texture and darkening the clone is the fast path when faces
reuse the same (texture, tint, light, UV window), which a block model's do constantly. It is
catastrophic when they do not, because the cost is `faces x texels` and nothing bounds it.
Three separate call sites have hit this, each found only after a process died:

| path | model | cost for one 64px icon |
| --- | --- | ---: |
| `renderFace` (geo) | 1,208-cube GeckoLib gun, 6,136 unique-UV faces | 20 GB |
| `renderElementModelWith` | 1,280-element prop over five sheets | ~1 GB/frame |
| `renderObjModel` | 1,493-triangle OBJ across 65 light buckets | 1.3 GB |

The rule for any new path that shades a face:

1. **Bound the memo by bytes**, not by entry count. Entry count says nothing about a 1024x1024
   sheet, and detailed models produce a distinct key per face.
2. **Fall through to `shadeTexel`** once the budget is spent, rather than refusing the item or
   dropping the memo. Per-sample shading costs pixels drawn (hundreds) instead of atlas texels
   (millions) and is exactly equivalent.
3. **Derive the shading parameters once** and share them between the memo and the fallback.
   Writing `1 - bucket / 64` in both branches invites a drift that renders plausibly either
   way and is therefore nearly impossible to spot.

`test/shading.test.ts` pins the equivalence the fallback depends on. It is the load-bearing
test for all three paths: if `shadeTexel` and `darkenTexture` ever disagree, every model past
its budget renders subtly wrong, and only those models.

Two failure modes are NOT solved by bounding, and were each tried and reverted:

- **Refusing the item** when it is too costly. It dropped ~70 icons including curated ones we
  ship ourselves.
- **Downscaling the texture** to fit. It works, but it loses authored detail for a problem the
  per-sample path solves outright.

## Testing

Fully self-contained: no fixture references a developer machine.

- Unit tests per module (locator, managers, model loader, salvage, geometry, blend math,
  item styles, animation, encode).
- Vanilla jars download at test time via mcversions.net (vitest globalSetup prefetches every
  version listed in `test/global-setup.ts` into `.work/fixtures/`); synthetic mod jars build
  from committed declarations in `test/fixtures/mods.ts` (cross-jar deps, every loader branch,
  OBJ+MTL, geo.json, junk JSON, modern definitions, 1.7.10 texture-only).
- Version matrix (`test/versions.test.ts`): releases across every era from 1.2.5 up, with
  coverage floors plus tint and must-render assertions.
- Real mods download from Modrinth at test time (Create, Sophisticated Backpacks, Bartering
  Station, Trading Post, Immersive Engineering); `RENDERMITE_SKIP_ONLINE=1` skips them offline.
  `RENDERMITE_MODJARS` points an extra env-gated suite at a local directory of jars.
- Golden pixel tests compare against a local render from the renderchest v5.1.0 docker image
  placed at `.work/golden/1.21.8-docker/`, and skip when it is absent. Published icon sets
  are not pixel ground truth (their PNGs are often palette-quantized and WebPs lossy).
- `scripts/sweep-mods.ts`: broad Modrinth coverage sweep with failure-class rollup; see also
  `scripts/coverage/`.

## Benchmark (same machine, same 1.21.8 assets, 64px q2, png+webp)

| | wall-clock | items written | items/min |
| --- | --- | --- | --- |
| renderchest v5.1.0 (docker, 8 cores) | 186s | 1,573 | ~506 |
| rendermite (one Node process, 8 worker threads) | 12.1s | 2,035 | ~10,070 |

Measured September 2026 from `dist/` with `--assets` on the extracted tree, median of warm
runs (the first cold read of the loose files took 29s). Current numbers come from the
benchmark suite below, not from this table.

## Continuous benchmarks (`bench/`)

`node --run bench` runs the Vitest benchmark suite over the render, encode and asset-access hot
paths for the working tree. `node --run bench:against -- --base <ref>` checks the base ref out
into `.bench/base` and measures both sides adjacent in one process (see `bench/sides.ts`).
CI runs it on pull requests, uploads `.bench/bench.json` as an artifact, and comments the
delta table (reporting only, never a gate).

Two things make the numbers usable on hosted runners:

- **The calibration group** (`bench/reference.bench.ts`) is a fixed arithmetic workload that
  runs byte-identical code on both sides, so its gap is the run's own noise floor. Never
  change that benchmark: it is the ruler.
- **Benchmarks assert their own workload.** Setup is top-level and each benchmark checks it
  actually rendered/encoded something. A benchmark measuring an empty loop reports a wonderful
  time.

Moves smaller than 10%, or smaller than the noise the run itself measured, are not called
out.
