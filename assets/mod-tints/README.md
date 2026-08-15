# Curated mod tint overrides

Item definitions for mod items whose tint colors are registered in client Java code and
therefore appear in no release's asset JSON. Layout is `<namespace>/items/<id>.json`, the
vanilla 1.21.4+ item-definition format, mounted with `FolderResourceManager` (see
`src/mods/tints.ts`). Nothing in the renderer special-cases these files.

## Precedence

This pack layers **above** the mod jars, unlike harvested overrides (which layer below so a
mod's own data always wins). Curated entries exist because the mod ships no usable data in
any release, and in the modern era the mod's own definition is typically an unrenderable
code-driven model type that would shadow the override. Delete an entry once the mod ships a
release that states the tint as data: the harvester will then source it authoritatively.

## Generated entries

`mysticalagriculture/` is regenerated from the mod's own bytecode rather than hand-authored:

```sh
node --experimental-strip-types scripts/mod-tints/mysticalagriculture.ts <jar>
```

No colour in it is hand-copied — see the script's header for what it reads. Everything else
here is hand-authored and needs the provenance note below.

## Adding an entry

Every entry needs its provenance recorded below, because these values are the only ones in
the project that cannot be traced to a jar. Hold a slot open with
`{"type": "minecraft:constant", "value": -1}` when a layer takes no tint. Values are signed
ARGB ints, matching vanilla's own definition files.

## Entries

### `mysticalagriculture` augments (54 items)

Every augment shares one greyscale sprite and is told apart purely by tint, so without these
they all render alike. Nothing in the mod's data states the colours: each augment class passes
a primary and secondary int up to `Augment.<init>`, and `lib/ModAugments` pairs the registry id
with the class. Both are read mechanically by the script above, against Mystical Agriculture
9.0.7. Delete the directory and regenerate if the mod restates them as data.

### `advanced_ae` quantum armor (helmet, chestplate, leggings, boots)

`#7110a5` on layer 1, sourced by eye and **not** verifiable against any jar. Checked:

- 1.21.1 models are `layer0: <piece>_base` + `layer1: <piece>_tint`, and both textures are
  fully grayscale, so nothing renders colored without an external value.
- The 26.1.x definitions use `"type": "advanced_ae:quantum_armor"` with no `tints` at all.
- `0x7110A5` appears in no class constant pool in AdvancedAE 1.21.1, AdvancedAE 26.1.7, or
  AE2 1.21.1.

The mod's own `quantum_crafter_terminal_part` tints with `ae2:color` (`color: fluix`), so
these pieces are very likely AE2's fluix purple. Teaching `resolveTint` the `ae2:color`
palette would replace these four files with a sourced value and cover ~116 other AE2-family
items that currently resolve no tint at all.
