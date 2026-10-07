# Mod coverage

How well rendermite renders real mods, measured against the most downloaded mods on Modrinth.
The harness lives in [`scripts/coverage/`](../scripts/coverage/README.md); this page records the
results and the method behind them.

## Results

| Survey | Items | Failed | Pass |
| --- | ---: | ---: | ---: |
| 30 mods (baseline) | 16,498 | 74 | 99.55% |
| 189 mods | 53,141 | 1,010 | 98.10% |
| 1,294 mods (top 1,200 by downloads), each alone | 98,688 | 3,690 | 96.26% |
| same mods, declared dependencies loaded | 112,424 | 1,903 | 98.31% |
| 2,999 mods (top 3,000 by downloads), declared dependencies | 232,785 | 5,527 | 97.66% |
| **same mods, dependencies inferred from assets too** | **255,949** | **3,757** | **98.53%** |

The raw rate falls as the survey grows mostly because larger surveys pull in more addons, not
because rendering gets worse. Loading dependencies is worth about two points on the same jars,
and the item count rises with it, since a resolved dependency makes items discoverable that were
not before.

Mods measured at zero failures include create, chipped, rechiseled (3,739 items), nuclearcraft,
aerial-hell, oh-the-biomes-weve-gone, quark, regions-unexplored, stoneworks, simply-swords,
storagedrawers, cc-tweaked, extreme-reactors, tetra, ad-astra and the Macaw's mods.

## Method

1. **Rank by downloads, do not curate.** `catalog.ts` pages Modrinth's search API sorted by
   downloads, so the survey is weighted by what people install. Many top mods are client-only
   (shaders, HUD tweaks) and survey as zero items almost instantly.
2. **Record the game version at fetch time.** `catalog.json` maps slug to `{game, version}`,
   so later runs never have to re-derive it.
3. **Load dependencies, score only the target.** An addon surveyed without the mod it extends
   reports false failures, and at scale those dominate. Pairing confirmed it: create-encased went
   from 715 failures alone to 0 with Create loaded, betterend from 222 to 22 with bclib,
   mekanismadditions from 113 to 2 with Mekanism. Chains can be more than one deep, and a missing
   dependency jar fails silently, so confirm every jar exists before trusting an unchanged result.
4. **Infer dependencies from assets, not just metadata.** Compat mods often reference a mod they
   never declare. `dependencies.ts` samples about 150 models per jar and records every namespace
   they reference that the jar does not provide. For one Macaw's compat mod, that turned 1,527
   failures into 13.
5. **Bucket failures with ids redacted** (`/[\w.]+:[\w/.]+/g` becomes `<id>`), so one defect
   across 400 items reads as one line. The bucket key is the renderer's own error message, which
   is why those messages must name what failed.

Always survey the newest release of a mod. Upstream often already fixed a reported icon, and a
stale cached jar sends you chasing it anyway.

`survey.ts` writes no shared state, so the catalog can be sliced across processes; jars are
cached, so re-running after a fix costs only compute.

## Deliberately not fixed

**A wrong icon reads as correct, which is worse than none.** These stay in the failure sidecar:

- **Spectrum's mob heads.** The skins are 128x128 custom Java skull models, so vanilla's head UV
  layout would sample arbitrary pixels. The `HEAD_LAYOUTS` gate rejects them on purpose.
- **Modern Industrialization's cables and pipes.** The textures are generic and the per-material
  colour is applied in code, so there is no data to render from.
- **Framed Blocks, `enderio:painted_*`, `ae2:facade`.** Camouflage blocks with no appearance of
  their own.
- **Ars Nouveau spell books.** Rendering them would need fuzzy geo model matching, which risks
  picking the wrong model.

Some failures come from the jar itself rather than the renderer, such as a model referencing
textures that no published jar contains. Those are left as failures rather than papered over.
