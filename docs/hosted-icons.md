# Hosted icons

Nodecraft renders every release and thousands of mods with rendermite and publishes the output to
`assets.rendermite.dev`, free of charge. The URL layout is listed on
[rendermite.dev](https://rendermite.dev/#hosted). `@nodecraft/rendermite/hosted` wraps it so you
don't have to know which layout an id lives under, which version to ask for, or how a pre-1.13 id
maps to its icon.

Like `/pack`, the entry is browser-safe: no `node:` builtin and no dependency, a few KB bundled.

```sh
npm install @nodecraft/rendermite
```

## The `<rc-item>` element

The quickest way to put an icon on a page. It loads one image per icon, so a page showing a handful
of items never downloads a whole stylesheet.

```ts
import { defineItemElement } from '@nodecraft/rendermite/hosted';

defineItemElement();
```

Without a bundler, import it from jsDelivr instead:

```html
<script type="module">
  import { defineItemElement } from 'https://cdn.jsdelivr.net/npm/@nodecraft/rendermite@1/dist/hosted.js';
  defineItemElement();
</script>
```

```html
<rc-item item="minecraft:diamond_sword" enchanted></rc-item>
<rc-item item="create:wrench" label="Wrench"></rc-item>
<rc-item item="minecraft:elytra" version="1.12.2"></rc-item>
```

| Attribute | Meaning |
|---|---|
| `item` | Item id. The namespace defaults to `minecraft`. |
| `version` | Game version for vanilla ids. Omitted, the element uses the latest published version. Modded icons are not versioned. |
| `enchanted` | Draws the enchant glint. Items the game always draws with it (enchanted book, experience bottle and friends) get it without the attribute. |
| `label` | Accessible name. Defaults to the item id. |
| `missing` | Set by the element when the image fails to load, so you can style `rc-item[missing]`. |

It is 64px by default; size it with CSS (`rc-item { width: 32px; height: 32px; }`). The image,
icon box and glint are exposed as `::part(image)`, `::part(icon)` and `::part(glint)`. The glint
stops animating under `prefers-reduced-motion`.

`defineItemElement({ tagName, baseUrl, client })` registers under another tag, points at a mirror,
or shares a client. It does nothing when `customElements` is missing, so it is safe to call during
server rendering.

The element shows each item as its standalone image, with default tints already applied. Recolouring
(`--rc-layer-1-tint`), armour trims, decorated pot sherds and loaded crossbows need the stylesheet.

## URL helpers

Synchronous, no network.

```ts
import { iconClass, iconUrl, stylesheetUrls } from '@nodecraft/rendermite/hosted';

iconUrl('minecraft:diamond_sword', { version: '1.21.8' });
// https://assets.rendermite.dev/icons/1.21.8/items/minecraft/diamond_sword.webp
iconUrl('create:wrench', { format: 'png' });
// https://assets.rendermite.dev/icons/modded/items/create/wrench.png

stylesheetUrls({ version: '26.3', namespaces: ['create', 'mekanism'] });
// [.../icons/26.3/rc-minecraft-64.css, .../icons/modded/css/create.css, .../icons/modded/css/mekanism.css]

iconClass('minecraft:iron_chestplate', { enchanted: true, trim: 'minecraft:gold' });
// 'rc-item rc-minecraft_iron_chestplate rc-enchanted rc-trim-minecraft_gold'
```

- `iconUrl` throws for a vanilla id without a `version` rather than guessing one. Use
  `client.latestVersion()` if you want the newest.
- `stylesheetUrls` always puts the vanilla sheet first. Mod sheets contain only their item rules;
  the base `.rc-item` rule and the glint live in the vanilla sheet.
- `iconClass` produces the same sanitized class the stylesheet generator writes. See
  [css-output.md](css-output.md) for what each class does.
- Ids keep their case. Pre-1.13 mod ids really are CamelCase.

## Client

`createHostedClient()` reads the CDN's index files and caches them. Immutable per-version files are
kept for the client's lifetime; `versions.json` and `namespaces.json` are refetched after five
minutes, matching the CDN's own cache. Failed requests are retried on the next call.

```ts
import { createHostedClient } from '@nodecraft/rendermite/hosted';

const hosted = createHostedClient();

await hosted.latestVersion();            // '26.3'
await hosted.versions();                 // newest first
await hosted.namespaces();               // every mod namespace on the CDN
await hosted.items('1.21.8');            // items-1.21.8.json, typed
await hosted.failures('26.3');           // [] when a version publishes no failures file

await hosted.item('minecraft:wool', { version: '1.12.2', damage: 14 });
// {
//   id: 'minecraft:wool',
//   url: 'https://assets.rendermite.dev/icons/1.12.2/items/minecraft/red_wool.webp',
//   className: 'rc-item rc-minecraft_red_wool',
//   version: '1.12.2',
//   displayName: 'Red Wool',
//   stackSize: 64,
// }
```

`item()` returns `undefined` when the version's registry does not list the id, or for a modded id,
when the namespace is not on the CDN. It resolves pre-1.13 damage values to the variant they draw
as, and follows ids whose icon is published under another name (`minecraft:deadbush` draws as
`dead_bush`). On items without variants, `damage` is durability and is ignored.

A registry entry is not a guarantee the image exists: a few code-drawn items have no icon. `failure`
carries the reason when the version publishes a failures file that lists the item, and the element's
`missing` attribute covers the rest. Modded results carry no `displayName`, since the CDN has no
registry for mods.

Options: `baseUrl` for a mirror, `fetch` to supply your own (for tests, or to add caching headers).
