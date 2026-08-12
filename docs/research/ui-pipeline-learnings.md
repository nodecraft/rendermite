# ui pipeline learnings (internal `ui` repo, scripts/minecraft-icons)

Extracted 2026-08-12 from the TypeScript pipeline that drove PHP renderchest via Docker.
File:line cites refer to that repo.

## 1. Version → renderchest mapping

**The table, verbatim** (`lib.ts:1427-1431`):

```ts
const RENDERCHEST_RANGES: Array<[floor: string, ref: string]> = [
	['1.21.4', 'v5.1.0'],
	['1.20.5', 'v2.10.1'],
	['1.14',   'v2.5.2'],
];
```

`renderchestRefForVersion` (`lib.ts:1433-1450`) resolution order:
1. `version === 'modded'` → recurses on `MODDED_VANILLA_BASE` (`1.20.4`) → **`v2.5.2`**. Rationale at `lib.ts:1434-1439`: v5 reads 1.21.4 `items/` definitions, the modded tree has `models/item/`, so v5 renders only builtin placeholders — "2 icons for actuallyadditions where the base's own ref renders 290".
2. Non-numeric versions (`/^\d+(?:\.\d+)*$/` fails) **throw** rather than floor — snapshots/typos compare as 0 and would silently pick v2.5.2 (`lib.ts:1440-1443`). Override via `RENDERCHEST_REF` env (`render-icons.ts:79`).
3. First range whose floor is `<=` version wins; else `v2.5.2` (the floor for *everything* older, including 1.0–1.13).

Verified boundaries (`test/nbt/minecraft-icons-pipeline.test.ts:1191-1217`): `26.2`/`1.21.4`→v5.1.0, `1.21.3`/`1.20.5`→v2.10.1, `1.20.4`…`1.14`→v2.5.2. **The v1.x line is unusable at any version** — it fatals generating the stylesheet because its `minecraft:unknown` placeholder never renders (`lib.ts:1424-1425`).

`compareMcVersions` (`lib.ts:35-45`) handles both `1.21.8` and the new `26.2` scheme by dotted numeric compare with `Number(part) || 0`.

### Other per-version floors and special-casing

| Constant | Value | Meaning | Cite |
|---|---|---|---|
| `ASSETS_DIRECTORY_FLOOR` | `1.6` | 1.6 moved everything under `assets/minecraft`; older jars keep textures at archive root | `lib.ts:662` |
| `TEXTURE_REFERENCE_VERSION` | `1.6.4` | pixel-match reference for naming pre-1.6 textures | `lib.ts:669` |
| `MODEL_FLOOR` | `1.8` | 1.8 introduced JSON block models + blockstates; nothing older describes its own geometry | `lib.ts:189` |
| `GEOMETRY_DONOR_VERSIONS` | `['1.8.9', '1.12.2']` | geometry donors for pre-1.8, layered oldest→newest | `lib.ts:196` |
| `MCMETA_REGISTRY_FLOOR` | `1.14` | below this, registry comes from PrismarineJS minecraft-data | `lib.ts:186` |
| `MCMETA_FALLBACK_VERSIONS` | `{components:'1.20.5', enchantments:'1.21'}` | borrow data the game had not yet made data-driven | `lib.ts:85-88` |
| atlas floor | `1.19.3` | texture atlases only ship from here; older need a synthesized stand-in | `fetch-assets.ts:165-176` |
| glint rename | `1.19.3` | pre-1.19.3 jars name it `enchanted_item_glint`; renderchest only knows `enchanted_glint_item` | `fetch-assets.ts:116-127` |
| `item/generated` root | `1.9` | item models only started parenting to `minecraft:item/generated` in 1.9; before that they named `builtin/generated` directly | `fetch-assets.ts:154-163` |
| `MODDED_VANILLA_BASE` | `1.20.4` | vanilla layered under modded; names the glint the modern way | `lib.ts:807` |

**Snapshot handling**: `resolveClientJar` checks `stable` then `snapshot` channels via mcversions.net. `resolveMinecraftDataPath` filters to full releases because snapshot keys like `15w40b` parse as 0 and would win every fallback. It groups patch releases (1.12.2 lives under `pc/1.12`).

**Pre-1.13 metadata orders** (exist in **no data source**, hardcoded at `lib.ts:245-346`):

```ts
const FILLER_WORDS = new Set(['wood', 'wooden', 'block']);
const ICON_SYNONYMS: Array<[from, to]> = [['light_gray', 'silver']];
const COLOUR_ORDER = ['white','orange','magenta','light_blue','yellow','lime','pink','gray',
	'silver','cyan','purple','blue','brown','green','red','black'];
const WOOD_SPECIES = ['oak','spruce','birch','jungle','acacia','dark_oak'];
```

`CURATED_VARIANT_ICONS` (`lib.ts:294-309`): `wool`, `carpet`, `stained_glass`, `stained_glass_pane`, `stained_hardened_clay`, `planks`, `sapling`, `wooden_slab`→`slab`, `log`, `leaves`, `log2`/`leaves2` (species offset `4`), and **`dye` which counts colours backwards** (metadata 0 = Ink Sac, the black end). Beds/banners deliberately absent — their metadata is orientation.

## 2. Asset preparation (vanilla)

### Layout handed to renderchest

`--assets` points at a directory whose **immediate children are namespaces** (not another `assets/` level):

```
assets/
  minecraft/
    atlases/blocks.json          # synthesized when absent (pre-1.19.3)
    models/item/*.json
    models/block/*.json
    models/item/generated.json   # synthesized when absent (pre-1.9)
    blockstates/*.json
    textures/{item|items}/*.png  # `items/`+`blocks/` pre-1.13, `item/`+`block/` after
    textures/{block|blocks}/*.png
    textures/misc/enchanted_glint_item.png (+ .mcmeta)
```

### Per-era work in `fetch-assets.ts`

- **≥1.6**: extract `assets/` from jar (bsdtar; GNU tar cannot read zip). Target `assets/` is deleted first — tar extracts over what's there; stale atlases silently change texture resolution.
- **<1.6**: whole archive to `raw/`, reshaped by `normalizeLegacyAssets`, `raw/` deleted.

### Pre-1.6 reshaping (`legacy-assets.ts`)

Constants: `MATCH_TOLERANCE = 40`, `SHEET_COLUMNS = 16`, `TILE_SIZE = 16`.

- **1.5.x**: individual files at archive root under old names (`oreDiamond.png`), from `raw/textures/{blocks,items}`.
- **≤1.4.7**: only `terrain.png` (16-wide block grid) and `gui/items.png`. Cell identity lived in hardcoded Java.
- Detection: `existsSync(raw/textures)` → `'files'` else `'sheets'`.
- **Sheet slicing**: `size = floor(width/16)`, cells extracted then nearest-resized to 16×16, row-major.
- **References**: every PNG in the 1.6.4 reference tree, first 16×16 frame only (animated strips), `.ensureAlpha().raw()`.
- **Matching**: `isBlankTile` = all alpha ≤ 8 (skipped). `pixelDistance` = sum of squared per-channel deltas over RGBA ÷ pixel count; nearest neighbour wins only if distance ≤ 40; **null over a poor guess**. First-match-wins via a `taken` set.
- Output uses **pre-1.13 plural dirs** (`textures/blocks/`, `textures/items/`). Glint: `raw/misc/glint.png` → `textures/misc/enchanted_glint_item.png`.

### Pre-1.8 geometry donors

For each donor in `['1.8.9','1.12.2']` in order, copy donor `minecraft/models` + `minecraft/blockstates` over the target (`force: true`, so 1.12.2 wins overlaps). Textures always stay the target version's. 1.8.9 omits item-model wrappers for ~200 blocks (would render flat); 1.12.2 supplies them; 1.8.9 fills era-only names (`lit_furnace`, `old_wood_slab`).

### Synthesized files

1. `minecraft/models/item/generated.json` = `{"parent":"builtin/generated"}` when absent — placeholders resolve through it; without it stylesheet generation dies after rendering everything.
2. `minecraft/atlases/blocks.json` when absent: `{"sources":[{"type":"directory","source":"<dir>","prefix":"<dir>/"}]}` per texture subdir. **Without atlases renderchest resolves only builtin models and still exits 0.**
3. Glint alias `enchanted_item_glint.png` → `enchanted_glint_item.png` (+ mcmeta).

## 3. Modded asset preparation

### Sourcing (`fetch-mod-assets.ts`)

Modes: default (namespaces.json → Modrinth), `--top N` (category crawl), `--jars <dir>` (local pack, rank -1 beats everything), `--ftb <ids>` (api.modpacks.ch).

- Slug resolution tries `namespace`, hyphenated, underscore-stripped, `farmersdelight`→`farmers-delight` style splits, then search; **every candidate confirmed by the jar containing `assets/<namespace>/`**.
- `MODDED_TARGET_VERSIONS`: 30 entries newest-first from 26.2 down to 1.7.10.
- Category crawl uses content categories; excludes `library`/`optimization` (raw download ranking is all libraries).
- Jar listing via bsdtar; **entries with absolute paths/drive letters/`..` reject the whole jar**.
- Namespaces from `/^assets\/([^/]+)\//` excluding `minecraft` and loader namespaces `['forge','neoforge','fabric','fabricloader','c','quilt','realms']`.
- Namespace must have item content: one of `models/item/`, `items/`, `textures/item/`, `textures/block/`.
- Only `['models','blockstates','textures','items','lang']` groups extracted.
- **`assets/minecraft/textures/` from mods** goes to a separate vanillasrc layer — mods add paths to the vanilla namespace; half of missing-texture failures were paths already held in a jar.
- Dependency chasing: namespaces referenced by extracted JSON but not sourced (Thermal → `cofh_core`) get one extra sourcing pass.
- 1.21.4+ mods flagged via `assets/<ns>/items/*.json` → `modern-namespaces.json`, rendered in a separate v5.1.0 pass.

### Layering (bottom → top): mod-provided vanilla textures → real 1.20.4 vanilla in full → mod assets → Faithful 32x Mods checkout (licence permits reuse w/ attribution; other packs are CC BY-NC-SA, excluded).

### Repair passes

- **`salvageJson`**: mods ship JSON with trailing junk (Gson tolerates, PHP dies, item silently lost). String/escape-aware depth scan returns first complete value.
- **`flattenLoaderModels`**: custom `loader` key → renderchest falls back to declared parent (usually textureless `item/generated`) → **black square**. Resolution: `perspectives.gui` → `base` → `childModel` → first `children` value → `/fluid_container|bucket/i` → `item/bucket`. **OBJ loaders left alone.**

### `synthesizeItemModels` — exact logic

1. `wanted(name)`: lang-file-declared ids filter (`^(?:item|block)\.<ns>\.(.+)$`, first dot segment); a mod with no lang file synthesizes everything.
2. Item textures first → `{parent:'item/generated', textures:{layer0:'<ns>:item/<name>'}}`.
3. `claimed` set: item sprite wins name collisions (concurrent writes to the same model path once interleaved into invalid JSON killing workers — one model per name is correctness).
4. Block textures skipped when claimed, unwanted, or face-suffixed (`_top,_bottom,_side,_front,_back,_end,_inner,_overlay`).
5. `models/block/<name>.json` exists → `{parent:'<ns>:block/<name>'}` (mod geometry always wins, never filtered).
6. Texture referenced by another model's faces → **skip** (custom geometry; wrapping a UV atlas over a cube renders scrambled).
7. `<name>_base` block model with no `<name>` → **skip** (block entity with unresolvable texture vars).
8. Else cube: `_top` present → `cube_bottom_top` (`side` = `_side` or base name); else `cube_all`.

### Per-namespace atlases

Every namespace **plus minecraft** gets a synthesized `atlases/blocks.json` — or none of its textures resolve.

### Credits/licences

`mod-sources.json` accumulates across invocations. Metadata from Modrinth or jar manifests (`fabric.mod.json`, `META-INF/mods.toml`, `neoforge.mods.toml` — regex-read; first `[[mods]]` block only; values with `${` rejected).

## 4. Render invocation (for parity reference)

```
docker run --rm [--cpuset-cpus N] -v assets:/assets:ro -v out:/out [-v builtin:/app/builtin:ro]
  --entrypoint php <image> -d error_reporting=8191 /app/renderchest
  --assets /assets --output /out (--namespace <ns>)+ --size 64 --format webp --fallback --item-list
```

- `error_reporting=8191`: older lines emit a deprecation per rasterized triangle on PHP 8.2.
- `--cpuset-cpus` never `--cpus` (quota invisible → worker-per-host-core → socket deaths).
- `minecraft` omitted from modded sets (would drag in trim dynamic resources whose textures the tree lacks).
- Retry logic: non-zero exit + no `*-64.css` → clear output (rmSync maxRetries 10) → retry once with unrenderable builtin item models pruned (parent-chain texture check, `#refs` skipped). Prune-on-retry not up-front: newer versions generate trim textures from atlases, not files.
- A failed-looking render **with** a stylesheet is kept (icons already on disk; a retry once destroyed 5913 finished icons over one failed item).
- Shard binning: longest-processing-time-first greedy by item-model count, deterministic tie-break.
- `--item-list` emits `rc-<firstNamespace>.json` — named after the first namespace, hence downstream renames to `rc-modded.*`.

## 5. Optimization

**sharp + lightningcss only, fully lossless, 64px only:**

```ts
png:  sharp(buf).png({ compressionLevel: 9, effort: 10, palette: true })
webp: sharp(buf).webp({ lossless: true, effort: 6 })
css:  lightningcss transform({ minify: true })
```

Only strictly-smaller candidates rewrite the file. Must run before first publish (immutable objects).

## 6. Output contract

### Vanilla per-version

```
icons/<version>/items/<ns>/<item>.webp + .png
icons/<version>/rc-minecraft-64.css
icons/<version>/rc-minecraft.json      # rendered item id list ["minecraft:stone", ...]
icons/<version>/rc-enchantment.webp/.png
icons/<version>/items-<version>.json   # registry
versions.json
```

Upload gate: `rendered >= registry/2` (a run whose textures never resolve renders only builtin models and exits 0 — must never publish). Icon sets legitimately exceed the registry (pre-1.13 damage variants).

### Modded (`icons/modded/`)

`namespaces.json` (uploaded LAST), `css/<ns>.css` (minified, urls rebased `../`), `sets/<ns>.json` (ids the published sheet actually styles), `items/<ns>/<item>.webp+.png`, `rc-modded.json`, `CREDITS.md`.

- CSS split by namespace: brace-balanced scan, namespaces matched **longest-first** (`create_andesite_alloy` vs namespace `create_andesite`; `cofh_core` has an underscore). Split against the full namespace list, never the `--only` selection.
- `dropRulesWithMissingIcons`: renderchest emits rules for items whose worker died. Rules referencing no image are scaffolding, kept.
- `rebaseIconUrls(css, '../')`: renderchest writes `url('items/…')` relative to the stylesheet's own location; sheets publish one directory deeper.
- lightningcss minify whole-sheet; on failure per-rule drop (unescaped selectors from junk texture names: `printer - Copy.png`, `2023-12-06_09.58.08.png`).

### CSS contract (consumer: NCMinecraftItem)

- Class = `rc-` + id with `:`→`_` and `[^\w.-]`→`_` (sanitisation is a security boundary).
- Rules are compound `.rc-item.rc-<ns>_<item>` (+ `:before` variants for layered items).
- `.rc-item` sets `position: relative` (documented specificity interaction).
- `rc-enchanted` class toggled at runtime; sheet supplies `@keyframes rc-enchanted` + `rc-enchantment.webp/png` overlay. This is why output is not sprite-stitched.
- `--rc-layer-1-tint` / `--rc-layer-2-tint` inline custom properties consumed by layer rules.
- Availability probe: computed `backgroundImage` on `.rc-minecraft_stone` — **every vanilla sheet must style minecraft_stone** or all icons fall back to text.
- Registry: `{version, items:[{id, displayName, stackSize, maxDamage?, numericId?, iconId?, variants?}], enchantments?}`.

## 7. Cross-cutting learnings

- **Silent-success is the enemy**: renderchest exits 0 after skipping everything unresolvable. Four guards exist (coverage plausibility ×2, synthesized atlas, missing-icon rule dropping). A rewrite with loud failures retires them.
- Windows: `rmSync` retries for lingering handles; sequential fetches (libuv assertion); bsdtar for zip.
- Better no icon than a wrong one (three independent decisions: legacy tile matching, UV-atlas skip, loader-model flattening).
- Retraction = delete icon then republish sheet; untouched namespaces left alone.
- Post-publish verification needs cache-busting query + `accept-encoding: identity`.
- Unknowns to read from a real sheet before committing to the CSS generator: exact tint-layer CSS, glint keyframes, PNG-fallback mechanism (sibling rule vs `image-set()`).
