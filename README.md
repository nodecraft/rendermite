# rendermite

Minecraft item icon renderer for Node.js. Point it at a game version or a pile of mod jars and it produces inventory-identical 3D item icons as optimized PNG and lossless WebP (plus optional GIF and AVIF), a ready-to-use CSS spritesheet, and a JSON item library.

> [!NOTE]
> **Heads-up:** this project was primarily AI-authored. The renderer, tests, tooling, and this README were written by Claude (Anthropic) in interactive sessions, with a human operator directing the work, reviewing output, and validating renders against real game assets. Read the code before trusting it in production.

## What it does

- **Renders items the way the inventory does**: orthographic block projection, per-face gui lighting, display transforms, tints, enchant glint layers, and animated textures (as animated WebP/GIF).
- **One codebase, every version**: 1.2.5 through the latest snapshots. Old versions are handled with era detection, donor geometry, and legacy spritesheet slicing; new ones with item definitions, atlases (including `paletted_permutations` armor trims), and dynamic items (trims, decorated pots, charged crossbows).
- **Serious mod support**: Forge/NeoForge/Fabric loader models (composite, separate transforms, fluid containers, split multiblocks), OBJ+MTL geometry, GeckoLib Bedrock `.geo.json`, cross-jar dependencies, Gson-tolerant junk JSON, case-insensitive 1.7.10-era assets, and synthesized models for texture-only jars.
- **Honest fallbacks, never black squares**: items the game draws in code fall through a chain of same-name block models, Bedrock geometry, builtin chest/head/banner/shulker geometry with the mod's own textures, dyed-variant tinting, and flat sprites. Every fallback is reported, and anything unrenderable fails loudly into a per-item failure sidecar instead of shipping a blank icon.
- **Optimized output**: PNGs use palette encoding only when provably lossless, WebP is lossless, and the generated CSS is minified with [lightningcss](https://lightningcss.dev). Output is smaller than the PHP renderer's on identical inputs.

## Install

```sh
npm install @nodecraft/rendermite
```

Requires Node.js 24+.

## Usage

Render a vanilla version (the client jar is downloaded and cached automatically):

```sh
rendermite --version 1.21.8 --output ./icons
```

Render a mod's items on top of a vanilla version:

```sh
rendermite --version 1.20.4 \
  --mod ./create-1.20.1.jar \
  --namespace create \
  --output ./icons/create --item-list
```

Or use an extracted asset tree directly:

```sh
rendermite --assets ./my-resource-pack --output ./icons
```

Useful flags: `--size <px>` (default 64), `--format webp|avif`, `--gif` for legacy-browser animation, `--lighting-profile modern|legacy`, `--concurrency <n>`. Run `rendermite` with no arguments for the full list.

### Output layout

```
icons/
  items/<namespace>/<item>.png     # always written
  items/<namespace>/<item>.webp    # lossless, animated where the item animates
  rc-enchantment.<format>          # each lossless glint format referenced by the CSS
  rc-<namespace>-64.css            # spritesheet CSS (class per item, enchant glint, tint layers)
  rc-<namespace>.json              # rendered item id list
  rc-<namespace>-failures.json     # per-item failures with reasons, never silent
```

### As a library

Everything the CLI does is exported, from the high-level `run()` down to individual pieces (`ModelLoader`, `TextureLoader`, `renderModel`, `prepareVersionResources`, `prepareModResources`, `generateStylesheet`).

```ts
import { run, prepareModResources, builtinPackPath } from '@nodecraft/rendermite';
```

## Performance

Benchmarked against PHP renderchest v5.1.0 on the same machine, rendering the same extracted 1.21.8 assets at 64px (PNG + WebP):

| | wall time | items written | silent drops | throughput |
| --- | --- | --- | --- | --- |
| renderchest (docker, 8 workers) | 210s | 1,573 | 33 | ~449/min |
| rendermite (one Node process, pool 8) | 22.9s | 2,065 | 0 | ~5,410/min |

## Testing

```sh
npm test
```

The suite is fully self-contained: vanilla jars download from Mojang at test time (cached under `.work/fixtures/`), synthetic mod jars are built from committed declarations, and real mods download from Modrinth. Set `RENDERMITE_SKIP_ONLINE=1` to skip the Modrinth suite offline, and point `RENDERMITE_MODJARS` at a local directory of jars to run the optional real-mod suite (third-party jars are license-restricted and never committed).

## Attribution

rendermite is a from-scratch Node.js renderer, but it owes its existence to [aternos/renderchest](https://github.com/aternosorg/renderchest) (MIT, © Aternos GmbH): the projection, rasterization, and lighting behavior were reverse-engineered from it for visual parity, and the hand-modeled builtin resource packs under [`assets/`](assets/README.md) (chests, banners, shulker boxes, mob heads, and friends) are vendored from it under the same MIT license.

## License

[MIT](LICENSE) © Nodecraft, Inc. Vendored `assets/` packs © Aternos GmbH, MIT.
