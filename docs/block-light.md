# Block light emission from bytecode

`light.json` in a block pack says how much light each block emits, 0–15, per blockstate where it
varies. This document is about where that comes from and how far it can be trusted.

## Why the code is the only source

No jar states a block's light. It is a property set in Java:

| era | how vanilla states it |
| --- | --- |
| 1.13–1.15 | `Block.Properties.lightValue(14)` on the block, and `getLightValue(state)` overridden on the class for anything state-dependent (`RedstoneTorchBlock`: `state.get(LIT) ? super.getLightValue(state) : 0`) |
| 1.16–1.21.1 | `Properties.lightLevel(state -> 14)`, a `ToIntFunction<BlockState>`; `litBlockEmission(13)` returns the lit/unlit lambda |
| 1.21.2+ | the same, with `register(String, Function<Properties, Block>, Properties)` |
| 26.x | ids move to `BlockItemIds`, `Blocks` reads them as static fields, and copper and colour families register through `WeatheringCopperCollection.registerBlocks` and `ColorCollection.registerBlocks` with lambdas |

Mods do the same in their own words: `DeferredRegister.register("x", () -> new X(...))` with the
properties built in the block's constructor, `ofFullCopy(Blocks.TORCH)` for a copy, or a loader's
`getLightEmission(state, level, pos)` override. So, as with entity geometry (see
`entity-geometry.md`), the extractor reads the bytecode. It is `src/blocks/light-bytecode.ts`, driven
from `src/blocks/light.ts`, and it is its own interpreter rather than the geometry one: geometry
follows a builder vocabulary and abstracts everything else; this follows *values*.

## How it works

Three ideas carry it:

- **Taint.** An object the interpreter cannot see into remembers the strings that went into it.
  `ResourceLocation.withDefaultNamespace("torch")`, `BlockItemId.create("torch")` and a mod's
  `new ResourceLocation(MODID, "glow")` all become a value that knows it is about `torch` or `glow`.
- **Registration by shape.** A call whose arguments carry a name and a block (or its `Properties`) is
  a registration, whatever it is called and whichever class it is on. Where the block is behind a
  `Supplier`, the supplier is run. A registration is also the end of the road: following it into the
  registry (holders, id maps, `ResourceLocation` validation) for a thousand blocks was the whole
  budget for nothing.
- **Concrete evaluation.** A light function is run once per combination of the blockstate properties
  it reads, with real values, so `lit ? 3 * candles : 0` comes out as its eight cases. Property
  domains come from the property objects themselves — `IntegerProperty.create("level", 0, 15)`,
  an enum's own constants — and the table folds to the commonest level as `default` plus the cases
  that differ, each stripped of the properties that do not change its answer.

Around those, the interpreter models what registries actually lean on: fluent `Properties` chains,
`<clinit>` of any class a `getstatic` reaches (on its own budget and at its own depth), lambdas and
method references including `TorchBlock::new`, string concatenation and `String.format`/`replace`,
`Map`/`List`/`Set` contents and iterators, `Arrays.stream(...).anyMatch(...)`, enum constants with
their serialized names, and a handful of `java.lang.Math`/boxing calls. Class initialisers reached
from inside a light function do not count against it: their branches are their own.

The registry classes to run are found by content, not name: the classes whose string constants name
the pack's blocks, plus (for 26.x) the class that reads the most static fields off those. The
`Properties` class is found by shape — the class with a fluent `(ToIntFunction)` method and at least
three no-argument fluent methods — plus the game's own by mapped name for a mod jar whose registry
never calls `lightLevel`. For 1.13–1.15 the `getLightValue` getter is found by shape too: the
properties method taking one `int`, the field it sets, the field the base block constructor copies it
into (through the synthetic accessor javac emits), and the base method that is nothing but a read of
that field.

A mod names the game's classes and members by their original names, so `parseMappings` now reads
member lines too, and every reference is remapped before it is looked up on an obfuscated client.
Registrations made by the game's own classes are tagged, so `immersiveengineering:lantern` cannot
inherit `minecraft:lantern`'s answer by sharing a bare name.

## What checks it

`VANILLA_LIGHT` in `src/blocks/light.ts` is a transcription from `Blocks.java` and the wiki, with a
short history for the entries that changed (the enchanting table did not glow before 1.18).
`test/block-light.test.ts` holds fourteen versions from 1.13.2 to 26.2 to it *exactly*, in both
directions: an emitter the interpreter misses and one it invents both fail. Two things the table got
wrong were found this way and corrected from the code: the vault's states (inactive is HALF_LIT 6,
the other three are LIT 12) and glow lichen (a lichen with no face at all is a real state and emits
0). Every vanilla export from 1.13 to 26.2 currently reads with zero `light` failures.

Nothing is guessed. A block whose registration was not found, or whose light function reads something
the interpreter does not model, is a `light` entry in `failures.json`, not a dark block. An
asset-only jar records one entry per namespace.

## Mods, and where it stops

Against the jars of a real modpack (FTB OceanBlock 2, 1.21.1 NeoForge):

| mod | result |
| --- | --- |
| torchmaster | 4/4, including `invisible_light` (15), which has no geometry at all |
| simplylight | 160/160 |
| occultism | 24 emitters, no failures |
| pneumaticcraft | 35 emitters, 3 blocks unresolved |
| ars_nouveau | 29 emitters (`light_block` per `level`), 34 blocks unresolved |
| supplementaries | 12 emitters, 141 unresolved |
| immersiveengineering | 5 emitters, 208 unresolved |
| chipped | 0 of 6,974: ids are built from palette templates the interpreter cannot expand |
| oritech | 0 of 211: blocks are registered by reflection over static fields |

The unresolved ones are honest: they land in `failures.json` as `no registration found in the code`.
The shapes that stay out of reach are template-driven id generation, reflection, and registration
helpers in libraries that are not in the jars being read. `--no-entity-geometry` disables class
reading altogether, and with it light; an `--assets` run has no code to read.

## Format

```json
"minecraft:torch": 14,
"minecraft:redstone_lamp": { "default": 0, "cases": [{ "when": { "lit": "true" }, "level": 15 }] },
"minecraft:candle": { "default": 0, "cases": [
  { "when": { "candles": "1", "lit": "true" }, "level": 3 },
  { "when": { "candles": "2", "lit": "true" }, "level": 6 },
  { "when": { "candles": "3", "lit": "true" }, "level": 9 },
  { "when": { "candles": "4", "lit": "true" }, "level": 12 }
] }
```

Only emitters are present; absent means 0. `blockLightLevel` from `@nodecraft/rendermite/pack` does
the lookup: the first case whose every property matches the state, else `default`. `meta.json`
carries `counts.light`; the file is absent when it would be empty.

Every block the jars *list* is asked about, not only those whose blockstate parsed into
`blockstates.json`: torchmaster's `invisible_light` states neither variants nor multipart and draws
nothing, and it lights a whole base. For a one-namespace mod export the mod's own registrations are
asked too, so a block with no blockstate file at all — nautec's prismarine crystal, drawn by a block
entity renderer — still gets its 15. A consumer must therefore read `light.json` by block id without
expecting a geometry entry to go with it. A block registered with a properties builder the
interpreter never recognised (a Fabric jar's `FabricBlockSettings`) is a failure, not a zero.

## Checked against a world

`ui`'s `test/nbt/bench/light-check.ts` recomputes block light for real chunks from `light.json` and
diffs it against the light the game saved, cell by cell, over chunks the game flagged as lit. On a
vanilla 1.21.5 world it matched on 100.00% of 6.1 million cells. On a heavily modded 1.21.1 save
(FTB OceanBlock 2, 67 mod namespaces exported from the pack's own jars) it matched 99.98% of 8.8
million overworld cells and 99.95% of 10.2 million cells in a dimension built from 290,000
`minecraft:light` blocks; what remains is cells the game itself saved as 0 next to a light source,
which looks like light the game had not yet recomputed after placing a structure.
