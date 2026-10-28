# rendermite

Minecraft item icon renderer for Node.js. Point it at a game version or a pile of mod jars and it produces inventory-identical 3D item icons as optimized PNG and lossless WebP (plus optional GIF and AVIF), a ready-to-use CSS spritesheet, and a JSON item library.

> [!NOTE]
> **Heads-up:** this project was primarily AI-authored. The renderer, tests, tooling, and this README were written by AI coding agents in interactive sessions, with a human operator directing the work, reviewing output, and validating renders against real game assets. Read the code before trusting it in production.

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

Useful flags: `--size <px>` (default 64), `--format webp|avif`, `--gif` for legacy-browser animation, `--lighting-profile modern|legacy`, `--workers <n>`. Run `rendermite --help` for the full list, and `rendermite blocks --help` for block packs.

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

### Block packs

A second output mode emits block **geometry and textures as data**, for a renderer that draws blocks itself rather than consuming finished icons. Java Edition, 1.13 (the Flattening) and up.

```sh
rendermite blocks --version 1.21.8 --output ./blocks/1.21.8
rendermite blocks --version 1.20.4 --mod ./create-1.20.1.jar --output ./blocks/create
```

```
blocks/1.21.8/
  atlas-0.png          # stitched sprite page(s), 4px edge-extended padding
  atlas.json           # sprite id -> rect, render layer, animation frames
  models.json          # model id -> baked elements, OBJ meshes, stated render layer
  blockstates.json     # block id -> variants/multipart, keys and predicates pre-parsed
  tints.json           # plains tints, colormaps, ramps, per-block tint semantics
  colormap/*.png       # the version's own grass/foliage/dry_foliage maps
  items.json           # flat item sprite stacks + their own atlas, for drawing dropped stacks
  entities.json        # entity names, marker colours, hitbox sizes, and which model each uses
  entity-models.json   # entity geometry recovered from the client's own bytecode + its atlas
  biomes.json          # the version's own biomes: climate, colour overrides, pre-1.18 numeric ids
  light.json           # light each block emits, read from the code
  behaviour.json       # hardness, collision, replaceability, map colour, read from the code
  tags.json            # the version's own tags, every registry, unexpanded
  advancements.json    # each advancement's criteria
  game-rules.json      # every game rule with its type and default
  names.json           # block and item display names from the lang files
  states.json          # every property and default state (with --reports <data generator reports>)
  failures.json        # anything not fully handled, with reasons, never silent
  meta.json            # version, counts, sha256 of every other file
```

Everything is pre-resolved: no parent chains, no `#texture` references, no variant-key parsing at runtime.

Mods are first-class. Forge/NeoForge **OBJ geometry** exports as triangle meshes alongside box elements (Create's crushing wheels, Immersive Engineering's slopes and connectors, Mekanism's pipes), stated `render_type` beats inference, arbitrary element angles and a third rotation axis are carried through, and a mod's broken assets cost a magenta face rather than the whole block. Verified by exporting a pack per jar across a 3,000-mod corpus. See [docs/block-pack-export.md](docs/block-pack-export.md) for the full contract.

### As a library

Everything the CLI does is exported, from the high-level `run()` and `exportBlockPack()` down to individual pieces (`ModelLoader`, `TextureLoader`, `renderModel`, `prepareVersionResources`, `prepareModResources`, `generateStylesheet`, `evaluateBlockState`, `packAtlas`).

```ts
import { prepareVersionResources, run } from '@nodecraft/rendermite';

const resources = await prepareVersionResources({ version: '1.21.8', jar: './1.21.8-client.jar' });
const result = await run({ resources, output: './icons', itemList: true });

console.log(`${result.rendered.length} rendered, ${result.failed.length} failed`);
```

The CLI also picks the era-appropriate builtin pack (chests, banners, heads) and donor jars for old versions, so it is the easiest starting point; [`src/cli.ts`](src/cli.ts) shows how it wires the pieces together.

Reading a published block pack needs none of that toolchain, so it has its own entry with no `sharp`,
no `node:` builtin, 13 KB bundled:

```ts
import { evaluateBlockState } from '@nodecraft/rendermite/pack';
import type { BlockPackModel } from '@nodecraft/rendermite/pack';
```

## Performance

Compared with PHP renderchest v5.1.0 on the same machine, rendering the same extracted 1.21.8 assets at 64px (PNG + WebP):

| | wall time | items written | throughput |
| --- | --- | --- | --- |
| renderchest (docker, 8 cores) | 186s | 1,573 | ~506/min |
| rendermite (one Node process, 8 worker threads) | 12.1s | 2,035 | ~10,070/min |

Both run with `--size 64 --format webp --fallback --item-list`, median of warm runs, measured September 2026. rendermite reports every item it could not draw in `rc-minecraft-failures.json`, and its summary counts files actually written. Run `node --run bench` for current numbers on your machine; CI runs the same suite and comments the delta on pull requests.

## Docs

- [DESIGN.md](DESIGN.md): architecture, version support matrix, mod support, output contract, performance notes
- [docs/block-pack-export.md](docs/block-pack-export.md): the block pack format, with [block light](docs/block-light.md) and [entity geometry](docs/entity-geometry.md)
- [docs/css-output.md](docs/css-output.md): the generated stylesheet
- [docs/renderchest-compat.md](docs/renderchest-compat.md) and [docs/renderchest-spec.md](docs/renderchest-spec.md): parity with renderchest
- [docs/mod-coverage.md](docs/mod-coverage.md): how mod coverage is measured

## Development

```sh
npm ci
node --run lint        # eslint with --fix (lint:ci for check only)
node --run typecheck
node --run build
node --run test
node --run bench       # benchmarks for the working tree
node --run bench:against -- --base main   # this tree against another ref, as CI does on PRs
```

The test suite is self-contained. Vanilla jars download from Mojang on the first run and real mods from Modrinth, all cached under `.work/fixtures/`; synthetic mod jars are built from committed declarations in `test/fixtures/mods.ts`. Environment variables:

- `RENDERMITE_SKIP_ONLINE=1` skips the suites that download mods from Modrinth.
- `RENDERMITE_MODJARS=<dir>` runs an optional suite against a local directory of mod jars. Third-party jars are never committed.

The [rendermite.dev](https://rendermite.dev) landing page lives in [`website/`](website/) as a static assets Worker with its own pinned wrangler. `npm ci --ignore-scripts && node --run dev` inside it serves the page locally. Pushes to `main` that touch it deploy through `.github/workflows/website.yml`, which reads `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` from the `website` GitHub environment.

The golden pixel tests compare against a local render from the renderchest v5.1.0 docker image placed in `.work/golden/1.21.8-docker/`, and skip when it is absent. The generators in `scripts/mod-models/` need a JDK (`javap`) and `unzip`; nothing else does.

## Contributing

Issues and pull requests are welcome. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) because [semantic-release](https://semantic-release.gitbook.io/) derives versions and the changelog from them, so use `fix:`, `feat:`, `perf:` and so on. Please run `node --run lint`, `node --run typecheck` and `node --run test` before opening a PR.

To report a security issue, see [SECURITY.md](SECURITY.md).

## Disclaimer

rendermite is not affiliated with or endorsed by Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Synergies AB. Rendered icons are derived from game and mod assets that you supply or download, so you are responsible for having the rights to render and publish them.

The icons hosted on `assets.rendermite.dev` show artwork that belongs to Mojang and to the authors of each mod. Nodecraft claims no ownership of it, hosts the renders free of charge, and grants no license to them; the MIT license covers rendermite's code only. Mod authors who want their icons changed or removed can [open an issue](https://github.com/nodecraft/rendermite/issues).

## Attribution

rendermite is a from-scratch Node.js renderer, but it owes its existence to [aternos/renderchest](https://github.com/aternosorg/renderchest) (MIT, © Aternos GmbH): the projection, rasterization, and lighting behavior were reverse-engineered from it for visual parity, and the hand-modeled builtin resource packs under [`assets/`](assets/README.md) (chests, banners, shulker boxes, mob heads, and friends) are vendored from it under the same MIT license.

## License

[MIT](LICENSE) © Nodecraft, Inc. Vendored `assets/` packs © Aternos GmbH, MIT.
