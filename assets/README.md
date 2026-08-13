# Vendored builtin resource packs

These packs originate from [aternos/renderchest](https://github.com/aternosorg/renderchest)
(MIT license, © Aternos GmbH) and provide the hand-modeled replacements for items the game
draws in code rather than through JSON models (chests, banners, shulker boxes, mob heads,
conduit, shield, decorated pots, and the internal `rc_*` layer sources used by the CSS
generators).

- `builtin/` — from renderchest master (v5.2.0-beta line), used for 1.21.4+ asset trees.
- `builtin-legacy/` — from renderchest v2.5.2, used below 1.21.4: it still carries beds and
  parents era-appropriate template models that modern jars renamed or removed.
- `builtin-bed-compat/` — just the bed geometry from v2.5.2, layered over 1.21.4–26.1 jars
  whose bed item models chain to `builtin/entity` (vanilla only shipped real bed block models
  in 26.2). Without it that whole era renders beds as fully transparent icons.

Layout is `<namespace>/<models|textures|items|atlases>/…` (no `assets/` nesting) — mount with
`FolderResourceManager` above the version's own assets.

`mod-tints/` is ours rather than vendored: curated item definitions for mod items that
register their tint colors in client code. See `mod-tints/README.md`.
