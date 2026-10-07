# renderchest behaviour reference (v5.2.0-beta.3)

How [aternos/renderchest](https://github.com/aternosorg/renderchest) renders, as read from its source at v5.2.0-beta.3 (commit 4b00eed). File:line cites refer to that revision; rendermite reimplements this behaviour.

Key global fact: **all pixel math runs on float color values in [0,1], in sRGB (non-linearized)
space. No gamma correction anywhere.**

## 1. Entry point & CLI

| Option | Default | Meaning |
|---|---|---|
| `--assets, -a` (string[], required) | – | asset roots, in priority order |
| `--namespace, -n` (string[]) | `["minecraft"]` | namespaces to enumerate |
| `--size, -s` (int) | 64 | final icon edge length |
| `--quality, -q` (int) | 2 | supersample factor |
| `--item-list, -i` (bool) | false | write JSON item list |
| `--output, -o` (required) | – | output dir |
| `--prefix, -p` | `rc-` | CSS class/file prefix |
| `--format, -f` | `webp` | output image format (library default is `png`) |
| `--fallback` (bool) | false | additionally emit PNGs + `@media (min-resolution: 1dpi)` block |

### Orchestration (`src/Output/ItemLibraryGenerator.php`)

1. Load glint texture `minecraft:misc/enchanted_glint_item`.
2. Render all items via taskmaster workers (default 8; fork workers w/ pcntl else proc_open+sockets;
   resource manager serialized per worker — no shared caches; each worker writes its own image file;
   parent writes CSS/JSON).
3. STYLE_GENERATORS order (significant): Internal, DecoratedPot, Armor, Potion, ChargedProjectile,
   Map, FireWorkStar, Enchanted, Default. First generator whose `hasItemStyle` matches wins.
4. Item name list always starts `["renderchest:unknown", "renderchest:empty"]`, then
   `getAllItems(ns)` per namespace, deduped.
5. Failures: `ItemResolutionException`/`TextureResolutionException` in a worker → item silently
   dropped (returns null). `InvalidItemDefinitionException` escapes as a task error.

### Render sizing

`item.render(size*quality, size*quality)` then per frame `resizeImage(size, size, FILTER_BOX, 1)`
— plain box average is the only antialiasing. Rasterizer itself has none.

### Output layout

- Images: `items/<locator with ":" → "/">.<format>` (e.g. `items/minecraft/stone.webp`,
  `items/_armor_trims/helmet_trim_gold.webp`).
- WebP: `webp:lossless=true`, all animation frames in one file (`writeImages adjoin`).
  PNG fallback = single current frame only (not animated).
- Stylesheet: `<prefix><namespaces[0]>-<size>.css` → `rc-minecraft-64.css`.
- Item list: `<prefix><namespaces[0]>.json` → flat JSON array of locator strings, task-completion
  order (nondeterministic), only successfully rendered items.
- Glint: `<prefix>enchantment.<format>`. **Upstream behaviour: the non-fallback write skips setFormat, so
  `rc-enchantment.webp` contains PNG bytes.**

## 2. Resource management

- `FolderResourceManager(paths)` **prepends `builtin/`** — builtin shadows user assets for file
  lookups. Then CLI roots in order, first match wins.
- Layouts: model `<ns>/models/<path>.json`, item `<ns>/items/<path>.json`, textures via atlas
  resolver → `<ns>/textures/<...>.png` (+ `.png.mcmeta`).
- `ResourceLocator` regex `#^(?:(\w+):)?(.*)$#` — namespaces `\w+` only, hence synthetic
  namespaces `_armor_trims`, `_leather_armor`, `_decorated_pot`, `_crossbow`.
- Dynamic resource generators own whole namespaces and are checked first in
  getModel/getTexture/getItem/getFileContent/hasFile.
- `getModel` parent resolution: only `/^(minecraft:)?builtin\/generated$/` is special-cased →
  `GeneratedItem`. `builtin/entity` is NOT understood — the builtin pack replaces those items.
- `CombinedResourceManager`: try children in order, swallow matching resolution exceptions.
- `PreRenderedResourceManager`: namespace of pre-rendered images → GeneratedItem per file
  (re-emit CSS without re-rendering).

### The builtin pack

- `builtin/minecraft/atlases/misc.json`: directory sources misc/, entity/, colormap/ + single
  `minecraft:item/unknown` → missingno. Makes `entity/*` and `colormap/*` addressable.
- `builtin/minecraft/models/item/generated.json`: copy of vanilla item/generated.
- `builtin/minecraft/items/*.json` — 73 definitions overriding vanilla to renderchest models:
  chests (9 + copper variants), copper_golem_statue family (8), 16 banners, 17 shulker boxes,
  heads/skulls (7 → `mobheads:item/*`), conduit, decorated_pot, shield, and internal split layers:
  `rc_potion_bottle{,_splash,_lingering}`, `rc_potion_content`, `rc_tipped_arrow_{base,head}`,
  `rc_filled_map_{base,overlay}`, `rc_firework_star_{base,overlay}`.
  Banners carry `tints:[{type: minecraft:constant, value: <ARGB int>}]`.
- `builtin/renderchest/`: `items/unknown.json`, `items/empty.json` (`minecraft:empty`), Blockbench
  entity models (chest family, banner, shulker family, conduit, shield, decorated pot base/overlay,
  potion/map/firework layer models). They parent vanilla templates (`item/template_chest` etc.)
  purely to inherit gui display transforms; explicit elements; `gui_light: side`; UVs pre-divided
  to 0–16. `texture_size` declared but ignored by code.
- `builtin/mobheads/`: 91 head items/models + 18 shared bases (`base/head_display.json`:
  gui_light side, display.gui.rotation [30,-130,0]; `head_32_32`, `head_64_32`, `head_64_64`,
  `head_64_64_overlay`, per-mob bases).

## 3. Item resolution (1.21.4+ `items/` definitions)

**v5 discovery is `items/` only** — no models/item fallback. `ItemType` map:
`minecraft:model`→ModelItem, `composite`→CompositeItem, `condition`→ConditionItem,
`select`→SelectItem, `range_dispatch`→RangeDispatchItem, `bundle/selected_item`→empty,
`empty`→EmptyItem, `special`→empty (SpecialItem). Unknown type → InvalidItemDefinitionException.

Every node may carry `transformation` (flat 16 col-major array or
`{translation, left_rotation quat, scale, right_rotation quat}` applied in that order),
accumulated parent·child down the tree.

- ModelItem: `model` + `tints[]`; renders model with accumulated transform.
- CompositeItem: renders children, merges animation timelines (min-delay stepping),
  composites source-over in array order.
- ConditionItem: property → on_true/on_false.
- SelectItem: loose `in_array` match (PHP `==` coercion), optional fallback,
  fallback-of-fallback = `renderchest:item/unknown`.
- RangeDispatchItem: `value = property * scale (default 1)`; picks the **first entry in file
  order** with `value >= threshold` (vanilla picks largest threshold ≤ value; with all
  properties 0 this takes the first threshold ≤ 0).

Static-render property defaults:
- Condition: all false, **except `view_entity` true**.
- String: `main_hand "right"`, `charge_type "none"`, `trim_material "none"`, `block_state ""`,
  `display_context "gui"`, `local_time ""`, `context_dimension "minecraft:overworld"`,
  `context_entity_type "minecraft:player"`, unknown "".
- Number: all 0.
- LocalTimeProperty: real current time via pattern (only dynamic one).
- Only override in pipeline: CrossbowModelGenerator sets `minecraft:charge_type` arrow/rocket.

## 4. Geometry, projection, rasterization, lighting

### 4.1 Model data application (parent chain applied root-first, child overrides)

- `display.gui` → ModelDisplaySettings(rotation ?? 0, translation ?? 0, scale ?? 1).
- textures merge into TextureList (value may be `{"sprite": ...}` object).
- `gui_light` → front/side; **Model default is SIDE**; GeneratedItem is FRONT.
- `elements` **replace** inherited entirely. Each Element captures its LightSource at
  construction — a child changing gui_light without redefining elements leaves parent
  elements on the parent's light.
- Texture `#refs` resolve lazily at render time against the final TextureList
  (cycle-detected); direct locators resolve immediately.

### 4.2 Elements

- from/to divided by 16 → unit cube space. Corners: a=to(max), g=from(min),
  b=(gx,ay,az) c=(gx,gy,az) d=(ax,gy,az) e=(ax,ay,gz) f=(gx,ay,gz) h=(ax,gy,gz).
- Face quads (v0,v1,v2,v3): DOWN=c,d,h,g; UP=f,e,a,b; NORTH=e,f,g,h; SOUTH=b,a,d,c;
  WEST=f,b,c,g; EAST=a,e,h,d.
- Auto-UV when absent (no vanilla 16-x mirroring — simplification):
  DOWN uv1=(x0,z1) uv2=(x1,z0); UP (x0,z0)/(x1,z1); NORTH (x0,y0)/(x1,y1);
  SOUTH (x0,y0)/(x1,y1); WEST (z0,y0)/(z1,y1); EAST (z0,y0)/(z1,y1).
- Rotation key `rotation_rc` ?? `rotation`; form A {origin, axis, angle} or form B
  {origin, x?, y?, z?} applied X,Y,Z. Applied AFTER faces/auto-UVs, mutates shared vertices.
  No 22.5° restriction, **no rescale**. origin/16.
- `shade_direction_override`: forces shading normal to a face direction (used by mobhead
  overlay/glow layers). UP(0,1,0) DOWN(0,-1,0) NORTH(0,0,-1) SOUTH(0,0,1) EAST(1,0,0) WEST(-1,0,0).
- FaceInfo: uv (pairs /16), texture, rotation (default 0), tintindex (default null).
  `cullface`, `color`, `texture_size`, `light_emission` ignored.

### 4.3 Transform stack & camera

- `transformation = outer(identity) · displaySettings.asMatrix4() · inner(item-def transform)`.
- Display matrix, pivot (0.5,0.5,0.5):
  `M = T(+.5) · T(translation/16) · S(scale) · Rz(-rot.z) · Rx(rot.x) · Ry(rot.y) · T(-.5)`
  — note negated Z rotation and Y→X→Z application order.
- Matrix4 column-major; quats standard; `rotateEulerRadians(x,y,z)` builds a quaternion in
  YXZ order: qx = sx·cy·cz + cx·sy·sz; qy = cx·sy·cz − sx·cy·sz; qz = cx·cy·sz − sx·sy·cz;
  qw = cx·cy·cz + sx·sy·sz (half-angles).
- **Projection**: orthographic, no matrix:
  `screen = ( round((x-0.5)*W + W/2), round(H - ((y-0.5)*H + H/2)) )` — unit cube fills the
  image, Y flipped, Z dropped, **rounded to integer pixels before rasterization**.
- Depth: `(z + 1) / 3` (zNear −1, zFar 2), larger = nearer.
- Backface culling: normal = shadeOverride ?? cross(v0→v2, v0→v1).normalize(), transformed by
  the upper-3×3, re-normalized; cull when `dot((0,0,-1), n) >= -0.01`. Degenerate normal or
  zero-area UV → skip face.
- Draw order: faces sorted ascending by untransformed model-space maxZ (stable sort) — only a
  tie-break; occlusion is per-pixel by depth.

### 4.4 Triangle rasterization (per face: two triangles (v0,v2,v3), (v0,v1,v2))

Scanline split-at-middle-vertex; per-scanline lerp of x, u, v, depth:
- `startX/endX = round(edge x at y)`; swap if start > end.
- `textureStep = 1/lineLength` (0 when zero length); `textureX` starts at `0.3 * textureStep`
  ("slightly move into the first step to prevent seams").
- Loop x from `startX-1` to `endX+1` (**1px color overdraw both sides**):
  - color written whenever the row has the pixel: sample = `texture[intval(u*W)][intval(v*H)]`
    (nearest by truncation; overwrite, no blending).
  - depth written only for `x in [startX, endX)`: alpha=1, red=depth. `textureX` advances
    ONLY inside this branch (leading overdraw pixel reuses 0.3·step; trailing reuse final).
- The overdraw band carries depth 0 → sorts beneath everything at composite time (seam filler).
- Writes go to a per-face private color+depth buffer.

### 4.5 Per-pixel compositing

For each pixel: sort face images ascending by their depth value (stable), then source-over
blend each non-null, alpha>0 color in that order. Straight-alpha over:
`ra = 1-(1-sa)(1-da); rc = (sc·sa + dc·da·(1-sa))/ra` (rgb=0 when ra=0).
(Upstream edge case: usort reindexes while the animation loop reassigns by original face
index — multi-frame multi-face models can attach a face image to the wrong slot.)

### 4.6 Lighting

- `light(n) = min(1, (max(0, d0·n) + max(0, d1·n)) * 0.6 + 0.4)`.
- Base directions (normalized before transform): `(0.2, 1.0, -0.7)` and `(-0.2, 1.0, 0.7)`.
- Front light transform: `scale(1,-1,1) · rotateY(-π/8) · rotateX(3π/4)`.
- Side light transform: `rotateEulerRadians(3.2375858, 1.0821041, 0) · rotateEulerRadians(3π/4, -π/8, 0)`.
- Shading normal is the transformed face normal (or transformed shade override) — lights live
  in view space.
- Application: on a clone of the face texture, restricted to the UV bbox expanded 1px, blend
  pure black with `alpha = (1 - light) * pixel.alpha` source-over per pixel. Opaque pixels →
  exactly `rgb *= light`; translucent pixels → rgb darkened AND alpha inflated to
  `1-(1-a·da)(1-da)`. Reproduce exactly for parity on translucent faces.

## 5. Textures

- No colorspace conversion — read PNG raw to RGBA8, no ICC/gamma.
- mcmeta: `frameTime = frametime ?? 1`, `width ?? 16`, `height ?? 16` (frame aspect in 16ths),
  `interpolate ?? false`, frames as number or `{index, time}`.
- Frame geometry supports **grids**, not just strips: `cols = intval(16 / meta.width)`,
  `frameWidth = imageWidth * meta.width/16`, `frameHeight = frameWidth * meta.height/16`,
  `x = (frame % cols)*frameWidth`, `y = floor(frame/cols)*frameHeight`.
- Frame count: 1 if not animated; else frames.length; else `round(H/frameH * cols)`.
- Static icon uses tick 0 → frame list entry 0 (or grid frame 0). Multi-frame textures produce
  animated multi-frame output images (WebP animation), not just frame 0!
- Animation assembly: ticks = lcm of all involved textures' lengths (≥1); interpolated
  animations capped at 128 emitted frames (`maxSkipableTicks = ceil(ticks/128)`); only faces
  whose frame changed (or interpolated) re-render; frame delay = 5cs × ticks elapsed
  (set on the PREVIOUS frame); last frame delay = 5cs; dispose = background(2).
- Interpolation: source-over blend of next frame at alpha=t over base (equals lerp for opaque).

## 6. Atlas sources

- Resolver map: `minecraft:directory|single|unstitch|paletted_permutations`. Sources are
  **unshifted** on add → last-loaded wins. Load order: builtin first, then CLI roots in order;
  per root: namespace dirs alphabetical, atlas files alphabetical, sources[] in order.
  Net: sources from the LAST asset root have the highest priority; builtin's sit at the bottom.
  Unknown source type → throws.
- Base source: locator must match source namespace; texture file =
  `textures/ + path + (.png unless already)`.
- directory: path must start with prefix; rewrite to `source + "/" + rest`.
- single: sprite id = `sprite ?? resource`, exact match, resolves `resource`.
- unstitch: crop regions scaled by divisor_x/divisor_y × base dims. **Upstream behaviour:
  baseHeight reads image WIDTH.** Animation metadata dropped.
- paletted_permutations (armor trims):
  - sprite = `<base path><separator ?? "_"><permutation name>`.
  - keyPalette: `palettes/<palette_key>.png`, map `encode(RGBA)` → row-major index;
    encode = `(R<<24)|(G<<16)|(B<<8)|A` with round(v*255). Duplicate colors: last wins.
  - getTexture: clone base; per pixel, if encode(pixel) in keyPalette → replace with
    permutation palette pixel at that row-major index (permutation image width may differ).
    Unmatched pixels unchanged. Full RGBA copy. No animation meta.

## 7. Dynamic resources (synthetic namespaces)

- `_armor_trims`: `<type>_trim_<material>` (+`_darker` for iron/gold/diamond/netherite) =
  GeneratedItem layer0 `minecraft:trims/items/<path>` → 60 items.
- `_leather_armor`: per type: `leather_<type>_base` (layer0 item/leather_<type>),
  `leather_<type>_overlay`, `leather_<type>_<material>_trim` (overlay + trim layer1) → 52 items.
- `_decorated_pot`: `pot_b_<sherd>` = renderchest:item/decorated_pot with west=#<sherd>,
  others #brick; `pot_o_<sherd>` = decorated_pot_overlay with south=#<sherd> → 48 items.
- `_crossbow`: `arrow`/`rocket` = minecraft:crossbow with `charge_type` property injected.

## 8. Tinters

Types: `constant` (value), `dye`/`firework`/`potion`/`map_color`/`team` (read `default`),
`grass` (colormap), `custom_model_data` (no tint), `renderchest:random` (16 dye colors,
memoized per instance).

- Constant parsing: null/−1 → no tint; int → ARGB (`b=v&0xff, g=v>>8, r=v>>16, a=v>>24`,
  alpha /255); `[r,g,b]` floats ×255 (alpha 255).
- ColorMapTinter: `x = floor(sampleX*W)`, `y = floor(sampleY*H)`, `index = y*W+x`, out of
  range → `#ff00ff`. **Upstream GrassTinter parsing turns temperature/downfall into
  `false`, so it samples (1.0, 1.0) = bottom-right corner.** Reproduce for parity.
- Tint index mapping: 3D faces `tintindex` → `tints[index]`; GeneratedItem layer N → tints[N].
- **`tintImage`: uses ONLY the red channel as luminance** — `blend = tint.rgb * pixel.R,
  alpha = pixel.alpha`, then source-over onto the pixel. Opaque = `tint.rgb * R`; translucent
  inflates alpha to `1-(1-a)²`. Applied per face clone BEFORE light darkening, and before the
  point-upscale for generated items.
- Dye colors: `#f9fffe #f9801d #c74ebd #3ab3da #fed83d #80c71f #f38baa #474f52 #9d9d97
  #169c9c #8932b8 #3c44aa #835432 #5e7c16 #b02e26 #1d1d21`.

## 9. Output / CSS

- JSON library = flat array of locator strings.
- CSS: entries joined `\n\n`, 4-space indent, no minification. Selector
  `.<prefix>item.<prefix><locator ":" → "_">`. urls `url('items/<ns>/<name>.<ext>')` relative
  to CSS. With `--fallback`: base rules PNG, `@media (min-resolution: 1dpi)` block upgrades to
  the configured format.
- Layer model: element bg (tint var layer-1 multiply, webkit-mask) / `:before` (layer-2) /
  `:after` (glint).
- ENCHANTED_EFFECT_ITEMS (always glinted): experience_bottle, enchanted_golden_apple,
  enchanted_book, written_book.
- Special generators + defaults: potion `#f800f8` (content layer + bottle overlay),
  map `#46402e`, firework star `#8a8a8a`, leather `#9e643f`; armor trims via
  `.rc-trim-minecraft_<material>` `:before` (darker variant when trim == armor material for
  iron/gold/diamond/netherite, `golden`→`gold`); decorated pot `.rc-pot-1-…`/`.rc-pot-2-…`;
  crossbow `.rc-projectile-minecraft_<arrow|spectral_arrow|tipped_arrow|firework_rocket>`;
  `minecraft:rc_*` items emit no rules.
- Glint CSS (see css-contract.md for the verbatim block): keyframes −256px 1024px → 256px
  −1024px, 32s linear infinite, 200% size, screen blend, opacity .6, blur(2px) contrast(200%),
  rotate(−8deg), background-size 512px 512px.

## 10. Constants

```
ANIMATION_TICK_LENGTH = 5cs; ANIMATION_MAX_FRAMES = 128
TRIM_MATERIALS = quartz iron gold diamond netherite redstone copper emerald lapis amethyst resin
TRIM_DARKER_MATERIALS = iron gold diamond netherite
ARMOR_ITEM_TYPES = boots leggings chestplate helmet
ARMOR_MATERIALS = leather copper chainmail iron gold diamond netherite
POTTERY_SHERDS = brick angler archer arms_up blade brewer burn danger explorer friend heart
  heartbreak howl miner mourner plenty prize sheaf shelter skull snort flow guster scrape (24)
defaults: size 64, quality 2, workers 8, prefix rc-
zNear/zFar: -1/2; cull epsilon -0.01; diffuse 0.6 gain + 0.4 ambient
light dirs (0.2,1,-0.7), (-0.2,1,0.7)
front light: scale(1,-1,1)·Ry(-π/8)·Rx(3π/4)
side light: rotEuler(3.2375858, 1.0821041, 0)·rotEuler(3π/4, -π/8, 0)
rasterizer: 0.3 sub-texel bias; ±1px color overdraw; FILTER_POINT layer upscale;
FILTER_BOX final downscale; colormap fallback #ff00ff
```

## Reimplementation gotchas (ranked by pixel impact)

1. Integer-rounded screen coordinates before rasterization.
2. tintImage red-channel-only luminance; tint+darken alpha inflation on translucent texels.
3. Per-pixel depth sort + alpha blend (no z-test); overdraw band carries depth 0.
4. Nearest sampling by truncation; 0.3·step scanline bias; textureX advances only while
   writing depth.
5. Stable ascending sort by untransformed maxZ for face order (coplanar faces: shulker inner
   cube 0.1–15.9, mobhead overlays 3.5–12.5).
6. builtin/ shadows user assets for files; atlas sources priority-REVERSED (last root wins).
7. All arithmetic in sRGB; no linearization.
8. Upstream quirks with a parity decision to make: GrassTinter corner sample, unstitch height-from-width,
   rc-enchantment.webp containing PNG bytes, combineFaceImages usort reindex,
   RangeDispatch first-match scan, double onProgress on failure.
9. Ignored by upstream: texture_size, cullface, element color, rescale, non-gui display slots.
