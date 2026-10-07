# renderchest compatibility by era

renderchest has no changelog, and different tags target different Minecraft eras with different
pixels. Icon sets rendered with renderchest in practice come from three tags:

| Minecraft versions | renderchest tag |
|---|---|
| 1.20.4 and older, plus modded | v2.5.2 |
| 1.20.5 to 1.21.3 | v2.10.1 |
| 1.21.4 and newer | v5.1.0 |

rendermite renders every era with one pipeline. This page records how those tags differ so output
can be compared against icons any of them produced. The modern pipeline itself is documented in
[renderchest-spec.md](renderchest-spec.md).

## Tag to Minecraft target

Inferred from commit content.

| Tag | MC target | Format driver |
|---|---|---|
| v1.x | 1.19.4 to 1.20.2 | atlases; aborts when its own unknown placeholder is missing |
| v2.0 to v2.2 | 1.20.2 | taskmaster workers |
| v2.3 to v2.5.2 | 1.20.2 to 1.20.4 | last of the original pipeline |
| v2.6 to v2.10.1 | 1.20.5 to 1.21 | map, firework and crossbow style generators added |
| v2.11 to v2.12.2 | 1.21.2 to 1.21.3 | resin trim, dynamic leather and pot generation; still `models/item` discovery |
| v3.0.0 | 1.21.4 | **`items/` definitions; `models/item` scan removed; tint tables become `tints[]`** |
| v3.1 to v3.5 | 1.21.5 | paletted_permutations `separator`; namespaced atlas types |
| v3.6 to v3.12 | 1.21.6 to 26.1 snapshots | copper family, mannequin, entity texture path moves |
| v4.0.0 | no format change | PreRendered/Combined resource managers; tolerant glint |
| v5.0.0 | 2026 snapshots | `transformation` in item definitions; Matrix4 pipeline |
| v5.1.0 | 2026 snapshots | normalized coordinates; **default gui_light becomes side**; bed overrides dropped |
| v5.2.0-beta.1 | newest | **palettes moved to `textures/palettes/`** |
| v5.2.0-beta.2 | newest | `shade_direction_override` replaces `shade: false` |
| v5.2.0-beta.3 | newest | vanilla two-direction diffuse GUI lighting |

## v2.5.2 specifics

- Discovery: flat `scandir(<ns>/models/item/)`, one item per JSON, keyed by basename
  (`minecraft:stone`). Same item-list shape as v5.
- Tinting is hard-coded by model path (`TinterManager`, removed in v3): explicit lists for
  foliage and grass models, potions fixed at `#375cc4`, a large spawn egg match table.
- Builtins include beds (dropped in v5.1.0 once vanilla shipped bed models).
- The front light is constructed inactive, so models without an explicit `gui_light: side` get
  no shading. Vanilla `block/block.json` does not set `gui_light`, so per v2.5.2's code most
  block icons from that tag are flat-lit isometric cubes.
- The display transform is baked into geometry at parse time (scale, rotY, rotX, rotZ, translate
  around 8,8,8); normals come from the transformed vertices.
- Depth is `abs(z/20)` per vertex.
- A missing glint texture is fatal (v4 and later tolerate it).
- `shade: false` is honoured by switching to the inactive front light.
- Grayscale PNG colorspace handling differs from later tags.

## Lighting before v5.2.0-beta.3

Every tag from v2.5.2 through v5.1.0 shares one `LightSource` model (`src/Model/LightSource.php`,
`Face.php`, `ModelGuiLight.php` at v5.1.0):

- Side light: active, `direction = normalize(0.75, -2, 0)`, `baseLight = 0.18`.
- Front light: **inactive**, so `gui_light: front` faces get no shading at all.
- Per face (v5.1.0 `Face.php:100-136`): transform vertices by the full matrix; project; take the
  normal from the transformed vertices (`cross(v0→v2, v0→v1)`, normalized) and cull when
  `dot((0,0,-1), n) >= -0.01`; apply the red-channel tint; then, if the light is active,
  `darkenAmount = max(0, (dot(n, direction) + 1) / 2 - baseLight)` and every pixel in the UV
  bounding box is source-over blended with black at `alpha = darkenAmount * pixel.alpha`.
- The computed value is darkness (0 is fully lit). v5.2.0-beta.3 inverts this: it computes light
  and darkens by `1 - light`.

| Tag | Default gui_light | Side light | Normal source |
|---|---|---|---|
| v2.5.2 | front (inactive) | single direction, 0.75,-2,0 / 0.18 | parse-time baked vertices |
| v2.10.1 | front (inactive) | same | same |
| v5.1.0 | side | same | transformed vertices |
| v5.2.0-beta.3 | side | two-direction diffuse, 0.6 gain + 0.4 ambient | normal through the direction transform |

## Pixel-relevant differences, v2.5.2 to v5.2.0-beta.3 (ranked)

1. gui_light default flip, plus the inactive front light at v2.5.2 (largest).
2. Lighting model rewrite (single direction with a 0.18 base vs two-direction 0.6/0.4).
3. `shade: false` replaced by `shade_direction_override`.
4. Transform order and precision: parse-time baked vs render-time matrices, pivot (8,8,8)/16 vs 0.5.
5. Depth formula change (changes z-fighting outcomes on coplanar faces).
6. Tint sourcing (tables vs definitions); colormap sampling made vanilla-exact in v3
   (`de99137`: index-wrapped lookup, `#ff00ff` fallback).
7. Grayscale colorspace handling moved (v3.6.1).
8. Generated (flat) items are never extruded in any version: 2D layer compositing only.
9. Parsing that only the newest tags accept: the `{"sprite": ...}` texture object form, per-axis
   rotation objects (v3.11.0), `rotation_rc`.

## Matching older icons in rendermite

rendermite implements the v5.2.0-beta.3 behaviour as its only pipeline, since it is the most
faithful to the game. `--lighting-profile` swaps the light sources:

- `modern` (default): two-direction diffuse, as in v5.2.0-beta.3.
- `legacy`: the single-direction side light and inactive front light described above
  (`src/render/lighting.ts`).

`legacy` reproduces the lighting of icons rendered by renderchest v5.1.0. It does not emulate the
older gui_light default: rendermite always defaults element models to `side` (and
`builtin/generated` to `front`), so block icons rendered by v2.5.2 or v2.10.1 that came out
unshaded will still differ.

## renderchest CLI surface

Unchanged from v2.5.2 through v5.2.0-beta.3: `--assets/-a` (repeatable), `--fallback`,
`--format/-f`, `--item-list/-i`, `--namespace/-n` (repeatable), `--output/-o`, `--prefix/-p`,
`--quality/-q`, `--size/-s`. v4 changed the library API (`fromAssetsFolders`), not the CLI.
rendermite keeps those flag names; run `rendermite --help` for its full set.
