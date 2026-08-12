# v5.1.0 lighting (what the 1.21.4+ reference corpus was rendered with)

Read from `git show v5.1.0:src/Model/LightSource.php` / `Face.php` / `ModelGuiLight.php`
on 2026-08-12. This predates master's v5.2.0-beta.3 two-direction diffuse rewrite, so
corpus pixel comparison for 1.21.4+ must use THIS model, not the master spec.

- `LightSource::getSideLight()` = `new LightSource(isActive: true, direction: normalize(0.75, -2, 0), baseLight: 0.18)`.
- `LightSource::getFrontLight()` = `new LightSource(isActive: false, direction: (0,0,1), baseLight: 1)` —
  **inactive: `gui_light: front` faces get no shading at all**.
- Face render order in v5.1.0 (`Face.php:100-136`):
  1. transform vertices by the full matrix;
  2. project;
  3. normal from **transformed** vertices (`getNormal(v0, v1, v2)` = cross(v0→v2, v0→v1) normalized);
     cull when `dot((0,0,-1), n) >= -0.01` (same as master);
  4. tint (same red-channel `tintImage` as master);
  5. if light source active:
     `darkenAmount = max(0, (dot(n, direction) + 1) / 2 - baseLight)`
     then per pixel in the expanded UV bbox: blend black with
     `alpha = darkenAmount * pixel.alpha` (source-over).
- Note the semantic flip vs master: here the computed value is *darkness* (0 = fully lit);
  master computes *light* and darkens by `1 - light`.
- No `shade_direction_override` (that lands in v5.2.0-beta.2); `shade: false` support was
  already gone by v5.1.0? — v2.5.2 honoured `shade` (`shade ? modelLight : frontLight`, i.e.
  false → inactive front light → unshaded). Check per-tag if a model relies on it.
- v2.5.2 uses the SAME LightSource class/constants (side normalize(0.75,-2,0), base 0.18,
  front inactive) but computes normals from parse-time-transformed geometry and defaults
  gui_light to FRONT (inactive!) — so at v2.5.2, blocks without explicit `gui_light: side`
  are unshaded. Vanilla block models ship no gui_light pre-1.15... BUT v2.5.2-era vanilla
  jars (1.20.x) have `gui_light` defaulting in code; block/block.json does not set it —
  meaning most BLOCK icons in the ≤1.20.4 corpus are UNSHADED (flat-lit isometric cubes).
  Verify against a corpus icon before assuming.

## Compat matrix for golden tests

| Corpus era | Tag used | gui default | side-light model | normal source |
|---|---|---|---|---|
| ≤1.20.4 + modded | v2.5.2 | FRONT (inactive) | single-dir 0.75,-2,0 / 0.18 | parse-time baked verts |
| 1.20.5–1.21.3 | v2.10.1 | FRONT (inactive) | same | same |
| 1.21.4+ | v5.1.0 | SIDE (`dcf19ec` is in v5.1.0 — confirmed via `git tag --contains`) | same single-dir | transformed verts |
| (none published) | master | SIDE | two-dir diffuse 0.6/0.4 | transformed normal via dir-transform |
