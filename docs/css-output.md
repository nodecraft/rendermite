# CSS and JSON output

A render writes, per run (`<prefix>` defaults to `rc-`, `<ns>` is the first `--namespace`):

| File | Contents |
|---|---|
| `items/<namespace>/<path>.<ext>` | one icon per item, plus layer sources under `items/_leather_armor/`, `items/_armor_trims/`, `items/_decorated_pot/`, `items/_crossbow/` and `rc_*` names |
| `<prefix>enchantment.<ext>` | the enchant glint texture |
| `<prefix><ns>-<size>.css` | the stylesheet described below, minified with lightningcss |
| `<prefix><ns>.json` | sorted JSON array of every item id that rendered |
| `<prefix><ns>-failures.json` | `[{ "id", "error" }]` for every item that did not |

The stylesheet follows renderchest's class contract, so markup written for renderchest output
works unchanged. Generator: `src/output/stylesheet.ts`; per-item classification:
`src/output/item-styles.ts`.

## Using it

```html
<link rel="stylesheet" href="icons/rc-minecraft-64.css">
<span class="rc-item rc-minecraft_diamond_sword rc-enchanted" style="width:64px;height:64px"></span>
```

- `rc-item` is required on every icon. Size it yourself; images use `background-size: cover`.
- The item class is the prefix plus the id with `:` replaced by `_`. Any character outside
  `[\w.-]` also becomes `_`, and `.` is escaped in the selector, so ids from mod jars cannot break
  the sheet.
- `rc-enchanted` adds the animated glint, clipped to the item's silhouette.
- All `url()`s are relative to the stylesheet. Library callers of `generateStylesheet` can pass
  `urlPrefix` to point them elsewhere.
- Items with no rule fall back to the `renderchest:unknown` placeholder from the base rule.

## Tints

Two custom properties drive layered items, multiply-blended into the background and masked to
the sprite's own alpha:

- `--rc-layer-1-tint` colours the element itself.
- `--rc-layer-2-tint` colours the `:before` overlay layer.

Set them inline to recolour an icon:

```html
<span class="rc-item rc-minecraft_leather_chestplate" style="--rc-layer-1-tint:#3c44aa"></span>
```

Defaults the sheet sets:

| Item | Variable | Default |
|---|---|---|
| leather armour | `--rc-layer-1-tint` | `#9e643f` |
| potion, splash potion, lingering potion, tipped arrow | `--rc-layer-1-tint` | `#f800f8` |
| filled map | `--rc-layer-2-tint` | `#46402e` |
| firework star | `--rc-layer-2-tint` | `#8a8a8a` |

## Variant classes

Added alongside the item class:

| Class | Applies to | Effect |
|---|---|---|
| `rc-trim-minecraft_<material>` | trimmable armour | trim overlay on `:before` (the darker palette is picked automatically when the trim matches the armour's metal) |
| `rc-pot-1-minecraft_<sherd>` | `minecraft:decorated_pot` | sherd pattern on the base image |
| `rc-pot-2-minecraft_<sherd>` | `minecraft:decorated_pot` | sherd pattern on `:before` |
| `rc-projectile-minecraft_<arrow\|spectral_arrow\|tipped_arrow\|firework_rocket>` | `minecraft:crossbow` | loaded crossbow |

A variant rule is only emitted when its image actually rendered for that version, so a sheet never
points at a missing file.

## Structure

In source order:

1. `@keyframes rc-enchanted`, which scrolls the glint background.
2. The base `.rc-item` rule: unknown placeholder image and mask, `--rc-layer-1-tint` multiply
   plumbing. A matching `.rc-item:before` rule carries the empty placeholder and
   `--rc-layer-2-tint`.
3. One rule per item. Plain items set their image and clear the mask (`mask-image: none`); a
   `.rc-enchanted` companion restores the mask so the glint is clipped to the silhouette.
   Layered items set a base image, a mask, a default tint and a `:before` overlay.
4. The glint rule on `:after`, shared by `.rc-enchanted` and by items that always glint
   (experience bottle, enchanted golden apple, enchanted book, written book).
5. With `--fallback`, every rule above uses PNG and a final `@media (min-resolution: 1dpi)`
   block repeats each `url()` in the primary format (WebP by default, or AVIF). Without
   `--fallback`, the rules use the primary format directly.

Masks are emitted unprefixed (`mask-image`); the minifier targets current Chrome, Edge, Firefox and
Safari, which all support it.
