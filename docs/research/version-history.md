# renderchest tag history and per-era behavior

Extracted 2026-08-12 from the git history of a local aternos/renderchest clone. No CHANGELOG exists;
mapping inferred from commit content. Matters to us because the published reference corpus was
rendered with **v2.5.2 (≤1.20.4 + modded), v2.10.1 (1.20.5–1.21.3), v5.1.0 (1.21.4+)** — three
different renderers with different pixels.

## Tag → MC target (condensed)

| Tag | MC target | Format driver |
|---|---|---|
| v1.x | 1.19.4–1.20.2 | atlases; **unusable** (fatals on own unknown placeholder) |
| v2.0–v2.2 | 1.20.2 | taskmaster workers |
| v2.3–v2.5.2 | 1.20.2–1.20.4 | last of the "old pipeline" used for ≤1.20.4 |
| v2.6–v2.10.1 | 1.20.5/1.21 | map/firework/crossbow style generators added |
| v2.11–v2.12.2 | 1.21.2–1.21.3 | resin trim, dynamic leather/pot generation; still models/item discovery |
| v3.0.0 | 1.21.4 | **items/ definitions; models/item scan deleted; tint tables → tints[]** |
| v3.1–v3.5 | 1.21.5 | paletted_permutations `separator`; namespaced atlas types |
| v3.6–v3.12 | 1.21.6–26.1 snapshots | copper family, mannequin, entity texture path moves |
| v4.0.0 | (no format change) | PreRendered/Combined resource managers; tolerant glint |
| v5.0.0 | 2026 snapshots | `transformation` in item defs; Matrix4 pipeline |
| v5.1.0 | 2026 snapshots | normalized coords; **default gui_light → side**; bed overrides dropped |
| v5.2.0-beta.1 | newest | **palettes moved to `textures/palettes/`** |
| v5.2.0-beta.2 | newest | `shade_direction_override` replaces `shade: false` |
| v5.2.0-beta.3 (master) | newest | vanilla two-direction diffuse GUI lighting |

## v2.5.2 specifics (the renderer behind most of the corpus)

- Discovery: flat `scandir(<ns>/models/item/)`, one item per JSON. Output key via basename →
  `minecraft:stone`. Same item-list shape as v5.
- Tinting **hard-coded by model path** (`TinterManager`, deleted in v3): explicit lists for
  foliage/grass models, potions fixed `#375cc4`, giant spawn-egg match table.
- Builtins include **beds** (dropped in v5.1.0 as vanilla ships models now).
- **Front light constructed inactive** — models without explicit `gui_light` got NO shading;
  `gui_light: side` used single-direction light `dir = normalize(0.75, -2, 0)`,
  `light = max(0, (dot(n, dir)+1)/2 - 0.18)`.
- Display transform baked into geometry at parse time: scale → rotY → rotX → rotZ → translate
  around center (8,8,8); normals from transformed vertices.
- Depth = `abs(z/20)` per vertex.
- Missing glint texture is fatal (v4+ tolerates).
- `shade: false` honoured (→ front/no light).
- Colorspace juggling differs (grayscale PNGs).

## Pixel-relevant differences v2.5.2 → master (ranked)

1. gui_light default flip + front-light inactive at v2.5.2 (biggest).
2. Lighting model rewrite (single-dir −0.18 base vs two-dir 0.6/0.4).
3. `shade: false` support removed (→ shade_direction_override).
4. Transform order/precision: parse-time baked vs render-time matrices, pivot (8,8,8)/16 vs 0.5.
5. Depth formula change (z-fighting outcomes on coplanar faces).
6. Tint sourcing (tables vs definitions); colormap sampling made vanilla-exact in v3
   (`de99137`: index-wrapped lookup, #ff00ff fallback).
7. Grayscale colorspace handling moved (v3.6.1).
8. Generated (flat) items are **never extruded** in any version — 2D layer compositing only.
9. Master-only parsing: `{"sprite": ...}` texture object form, per-axis rotation objects
   (v3.11.0), `rotation_rc`.

**v5.1.0 (corpus renderer for 1.21.4+) predates the beta.3 lighting rewrite** — its GuiSideLight
differs from master. See `lighting-v5.1.0.md` for the exact code we must match for corpus parity.

## CLI stability

Flag surface identical v2.5.2 → master: `--assets/-a` (repeatable), `--fallback`, `--format/-f`,
`--item-list/-i`, `--namespace/-n` (repeatable), `--output/-o`, `--prefix/-p`, `--quality/-q`,
`--size/-s`. v4 changed the library API (`fromAssetsFolders`), not the CLI.

## Parity strategy decision (rendermite)

Implement the **master-spec modern pipeline** as the one true renderer (it is the most
vanilla-accurate). For golden-image validation, add a `--compat <tag>` lighting/behavior toggle
implemented as pluggable light sources + a few flags (front-light-inactive, single-dir side
light, depth formula) so we can pixel-compare against what the corpus actually contains per era:

- ≤1.21.3 corpus icons: v2.5.2/v2.10.1 behavior (front light inactive, single-dir side light).
- 1.21.4+ corpus icons: v5.1.0 behavior (pre-beta.3 gui lights).

Default output (no compat flag) uses master behavior everywhere, which supersedes the corpus.
