# Entity geometry

Minecraft has never shipped an entity model as data. Not at any version: the 26.2 client jar carries
850 entity *textures* and zero entity models, because every mob's shape is Java code —
`CubeListBuilder.create().texOffs(18, 4).addBox(-6, -10, -7, 12, 18, 10)` and so on, run at startup.

So a renderer that wants to draw a cow has three options: hand-model every mob, redistribute somebody
else's models, or **read the code**. rendermite reads the code.

Except where there is none to read: a GeckoLib mod ships Blockbench's bedrock format and registers it
by resource location, so that path converts the geometry instead. Both end up as the same model.

## What comes out

`entities.json` gains a `model` per entity, pointing into `entity-models.json`:

```jsonc
// entities.json
"minecraft:cow": {
  "name": "Cow",
  "texture": "minecraft:entity/cow/cow",
  "color": "#61544b",
  "model": "net.minecraft.client.model.CowModel"
}
```

```jsonc
// entity-models.json
{
  "padding": 4,
  "pages": [{ "file": "entity-atlas-0.png", "width": 1024, "height": 1024 }],
  "sprites": { "minecraft:entity/cow/cow": { "page": 0, "x": 708, "y": 420, "w": 64, "h": 32, "layer": "cutout" } },
  "models": {
    "net.minecraft.client.model.CowModel": {
      "textureSize": [64, 32],
      "parts": [{
        "name": "body",
        "pivot": [0, 5, 2],
        "rotation": [1.5707964, 0, 0],
        "cubes": [{ "origin": [-6, -10, -7], "size": [12, 18, 10], "uv": [18, 4] }],
        "children": []
      }]
    }
  }
}
```

Models are keyed by the **class** they came from, and several entities point at one: a husk and a
drowned are both drawn by the zombie's model, and a minecart's five variants are one `MinecartModel`.
On 1.21.1 that is 102 entities sharing 78 models.

`textureSize` is the sheet a cube's `uv` is in, which is *not* the atlas page — map `uv` through it into
the sprite's rect, exactly as a block face does. **Prefer the sprite's own `w`/`h` and keep this as the
fallback**: from 1.21.4 a boat and a chest boat are both a `BoatModel` drawn on a 128x64 and a 128x128
sheet, so no single value in the model is right for both. Where the entities sharing a model do agree,
the exporter writes that agreed size here rather than whatever the code stated.

The file is self-contained and lazily fetchable: a consumer that never draws a mob fetches none of it.

## How it works

`src/entities/` is seven pieces:

| file | job |
| --- | --- |
| `classfile.ts` | a minimal class-file reader: constant pool, methods, `Code` |
| `model-bytecode.ts` | abstract interpretation of the builder calls |
| `mappings.ts` | Mojang's obfuscation maps, or the identity where none are needed |
| `jar-classes.ts` | `.class` entries out of a jar, by internal name |
| `model-code.ts` | which classes count as model code, and their parsed form |
| `inherit.ts` | a class read together with its ancestors |
| `merge.ts` | folding two pieces of one model together, by part name |
| `link.ts` | which class holds a given entity's geometry |
| `model.ts` | the shape both sources produce |
| `geo-model.ts` | bedrock `.geo.json`, converted into that shape |

plus `src/blocks/entity-geo.ts`, which finds the `.geo.json` a given entity is drawn from.

**Calls are classified by descriptor shape, not class name.** Six floats is `addBox`, two ints is
`texOffs`, three floats is a pivot or a `PartPose`, `(String, builder, pose)` is `addOrReplaceChild`.
That one decision is why a single interpreter covers obfuscated vanilla (`fyp.a(FFFFFF)Lfyp;`),
deobfuscated vanilla, and a mod shipping its own copy of the API
(`AdvancedModelBox.addBox(FFFFFFFZ)V`) with no per-mod table.

**A modded export reads the mods' classes too.** The class source is layered, mods over the client, the
same way the resource managers are. It was the client jar alone until this was noticed, which meant a
mod writing its models in Java — most of them — had every mob drawn as a box however good the
interpreter was.

**Calls into the model's own code are followed, with their arguments.** A model is almost never built
in one method, let alone one class. `CowModel` calls `super(12, 0)` and inherits four legs whose height
*is* that 12; 26.2's `PigModel` starts from `QuadrupedModel.createBodyMesh(6, …)` and replaces only the
head; a witch is a villager with a hat, and `VillagerModel` is neither her superclass nor named
anything like her. So a call whose target is model code runs in a nested frame, with the receiver and
arguments in its locals, sharing the handles and fields of its caller. Reading one class alone gave a
cow with two parts; reading it without the arguments gave four legs of height zero.

Two rules keep that from over-reaching. **Assignment replaces**: a subclass writing a field its
superclass already filled is an override, which is how a cow keeps its own head and its inherited legs,
and `addOrReplaceChild` is named for the same thing. And **only model code may follow calls into model
code**: a renderer constructs the models it draws, so letting it follow made a renderer look like it
held their geometry, and a pufferfish renderer that builds all three sizes came out as one model with
three sets of spines. The line is drawn by name in `model-code.ts` — anything with `model` in its path
except the `client.model.geom` package, which is the builder API and stays abstract.

What the calls cannot reach — a builder that loops, a frame past the budget — is filled in afterwards
by merging each ancestor's own extraction, taking only the part names the subclass never mentioned.
That still earns its place: worth 96 cubes on 26.2, and nothing at all on the modpack corpus.

**The jar decides whether a mapping is needed.** Mojang published obfuscation maps from 1.14.4 to
1.21.11 and then stopped — because from the 26 line the client is not obfuscated at all. So
`resolveMappings` looks at the class list first and uses identity mappings when the models are already
in the clear, which keeps a current version's export offline-capable. The test is
`net/minecraft/client/model/` specifically: an obfuscated jar keeps a couple of dozen classes in the
clear (its launcher entrypoint is never obfuscated), so a looser check reads 1.21.1 as unobfuscated.

**Linking an entity to its class** takes the cheapest route that works:

1. `<Type>Model`, wherever it lives. Not a fixed package — 1.21.11 moved `CowModel` to
   `client.model.animal.cow`.
2. That class's own **superclass chain**, because `ZombieModel` is an empty shell two hops above
   `HumanoidModel`, which is where the boxes are.
3. `<Type>Renderer` and *its* superclass chain: a renderer that subclasses another never names its
   model, so `CaveSpiderRenderer` hands a layer to `SpiderRenderer` and only that names `SpiderModel`.
4. `RENDERER_ALIASES`, for the mobs whose holder is simply not named after them — a mooshroom is a
   `MushroomCowRenderer`, a wither a `WitherBossRenderer`, a skeleton horse an `UndeadHorseRenderer`.
5. `FAMILY_PATTERNS`, for a family that shares one model: 1.21.2 split boats into one entity type per
   wood, twenty of them, all still a `BoatModel`.
6. **Normalised name**, for mods. `Lionfish_Model`, `ModelLionfish` and `LionfishEntityModel` all
   reduce to `lionfish`. Last, and only for mods: a fuzzy match is a guess and must never beat a class
   the game actually points at.

7. **A vanilla model under a mod id**, last of all. Plenty of mod entities are drawn with the game's
   own models and ship no geometry because they need none: Ars Nouveau's `summon_horse` is a horse,
   its `ally_vex` a vex, and a mod adding a spawner for one calls it `iron_golem_spawner`. So the
   decoration comes off a token at a time and the routes above are retried on what is left, longest
   match first — which is why that last one finds the iron golem rather than stopping at `iron`. Worth
   67 of the modpack corpus's entities, and the reason the class source has to span the jars.

An entity is credited to the most derived class that carries geometry, which — since the calls are
followed — is usually its own: a zombie is a `ZombieModel` holding the humanoid shape it inherits,
rather than a `HumanoidModel` shared with everything else humanoid.

A mod's own `.geo.json` beats that last route and loses to every other: dropping tokens until something
matches is a guess, and if the mod ships geometry under its own name then that is what the game draws.

`NO_MODEL` lists the types the game draws with no `ModelPart` hierarchy at all — a dropped stack, a
falling block, a marker, the display entities, the projectiles it draws as item sprites. It exists so
that a version adding a mob cannot slip through as "expected to have nothing": the coverage test fails
on any type that is neither linked nor listed.

## Coverage

Share of the entity types that *should* have geometry, from the version matrix in
`test/entity-geometry.test.ts`:

| version | with geometry | share | cubes | distinct models |
| --- | --- | --- | --- | --- |
| 1.14.4 | 82 | 100% | 719 | 61 |
| 1.16.5 | 88 | 100% | 798 | 65 |
| 1.18.2 | 91 | 100% | 814 | 67 |
| 1.19.4 | 98 | 100% | 898 | 74 |
| 1.21.1 | 102 | 100% | 939 | 78 |
| 1.21.4 | 125 | 100% | 1171 | 81 |
| 1.21.8 | 126 | 100% | 1148 | 82 |
| 1.21.11 | 132 | 100% | 1223 | 85 |
| 26.2 | 133 | 100% | 1256 | 85 |

Every entity type that should have geometry has it, on every version from 1.14.4 up. The coverage test
asserts that exactly rather than with an allowance, so a new mob that links to nothing fails the build,
and it pins the cube counts too. Those counts are around a fifth higher than before calls were
followed, and much of the difference is parts that had been missing since 1.14: the four legs of every
quadruped, at the height its constructor asked for.

Modded, measured across the 309 jars of a real modpack, with the client's classes layered under theirs:

| route | types |
| --- | --- |
| the mod's own model class | 103 |
| a vanilla model under a mod id | 67 |
| the mod's own bedrock geometry | 50 |
| named model or alias | 4 |
| **total** | **224 of 327 (69%)**, 8,778 cubes |

The whole sweep is 16 s for 309 jars.

Extraction is not a meaningful cost, per `bench/entities.bench.ts` against 1.21.8: reading every model
class in the jar up front is 71 ms, interpreting all 102 of them is 8.9 ms, and one entity is ~1 ms to
extract and ~0.7 ms to link. A 546-pack seed pays about a minute for the lot.

## What it will not do

**A builder with a loop stops at the loop, and says so.** Following one emits every segment at the same
place, and a wrong shape is worse than a recorded gap, so what was built before the loop is kept and
the rest is not. Seven vanilla models are in this position and they are all the same kind of thing: a
ghast's nine tentacles, a squid's arms, a guardian's spikes, the ender dragon's neck and tail.

**Conditionals are taken, and noted.** A model builder's branches are all on a constructor argument — a
`CubeDeformation`, a baby-variant flag — so every arm builds a real shape and the fall-through is one
of them. The model carries a note saying which of several shapes it is.

**A part whose parent cannot be identified comes out as a disconnected root.** It keeps its own pose
and hangs from the model root instead, which is the most that can honestly be said about it, and the
model carries a `disconnected roots` note, because a consumer cannot tell from the geometry alone.

**No vanilla model is in that position any more**, on any version from 1.14.4 up. Nine were before
calls were followed; the last was the donkey, whose chest is added inside a `MeshTransformer` lambda —
`LayerDefinition.apply(mesh -> modifyMesh(mesh.getRoot()))`. A lambda is now followed rather than
consumed, which takes two hops through the class file: the `invokedynamic` names a row of
`BootstrapMethods`, and that row's method handle names the body. A mod's model can still land here.

**1.13.x gets nothing.** Obfuscated, and from before Mojang published the maps. Reported once against
the version rather than once per mob.

**A model registered dynamically is not found.** The bedrock path is a search by name, because the
registration is a Java call returning a resource location. It handles the ways mods actually spell
their own names (below) and nothing cleverer.

**An `--assets` run gets nothing**, because a folder of assets has no code in it. Pass a jar.

## GeckoLib, and the bedrock format

A GeckoLib mob has no model class to read: the geometry is a `.geo.json` asset and
`GeoModel.getModelResource` names it at runtime. So `geo-model.ts` converts that file into the same
model shape, and the collector reaches for it **only when the linker found no class** — a mod that
writes its models in Java is never second-guessed by a name match.

### One conversion, and how it is checked

A `ModelPart` is authored with **y running downwards from 1.5 blocks above the mob's feet**, because
`LivingEntityRenderer` draws the model through `scale(-1, -1, 1)` after translating down by 1.501
blocks: a model point `p` lands at world `(-p.x / 16, 1.5 - p.y / 16, p.z / 16)`. Bedrock is authored
**y up from the feet** and mirrored in x the same way, so the whole conversion is one flip:

```
java = [b.x, 24 - b.y, b.z]
```

A mirror reverses two of the three rotations, and bedrock's own sign convention reverses two others, so
they compose to `[r.x, -r.y, -r.z]` in radians.

That is four sign choices and one constant, every one of which produces a model that validates
perfectly and draws wrong — upside down, mirrored, or twisted at a single joint. So none of it is taken
on trust:

- **An oracle that already draws these models.** `geoToFaces` rasterises bedrock geometry for GeckoLib
  *item* icons in production. Convert, evaluate with vanilla's own part semantics, and every corner has
  to land where it puts it: **135 of 135 geometry files** across four mods, exactly.
- **The sign convention is forced, not chosen.** The test sweeps all eight combinations and asserts only
  the one in use agrees. Negating a rotation in the input is the same as negating it in the conversion,
  so this is a real sweep rather than a restatement.
- **An oracle from the game.** Creeper Overhaul's creepers keep vanilla's skeleton: their legs pivot at
  bedrock y 6, and a vanilla creeper's at 18. 24 - 6 = 18.
- **Feet on the ground.** Bedrock authors a mob standing on y 0, so a converted one stands on 24. Held
  against the raw file rather than against our own evaluation of it, which is what catches an inverted
  flip that is otherwise self-consistent.

### What the format needs that Java does not

**Per-face texture rects.** `addBox` always unwraps a box the same way; bedrock can give each face its
own rect, and 56% of the corpus's 2,146 cubes do. So `EntityPackCube.faces` carries them, and a
consumer that ignores it draws over half of every modded mob from the wrong part of the sheet.

Three more bedrock habits are folded into the Java shape rather than added to it: a **cube-level
rotation** (18% of cubes) becomes a part of its own, which is what a `ModelPart` with one box is; a
**negative size** is normalised to a positive box, since Ars Nouveau's `empty` is authored as
`origin [8, 16, 8], size [-16, -16, -16]` and a consumer would draw that inside out; and a bone naming
a **parent the file never defines** becomes a root with a note rather than being dropped.

### Finding the file

An entity id and its geometry's filename agree less often than you would hope, and they disagree in
three shapes, each of them because a real mod does it:

1. **The same name spelled differently.** Ars Nouveau registers `bookwyrm` and ships `book_wyrm`.
2. **A decorated entity, a plain model.** `familiar_drygmy` is drawn by `drygmy`, `marid_unbound` by
   `marid`. A geo whose every token appears in the entity's name qualifies, most specific first: a
   subset test rather than a similarity score, so an unrelated model can never win.
3. **A plain entity, a decorated model.** Occultism registers `foliot` and ships only its jobs
   (`foliot_worker`, `foliot_crusher`, …). Any of them is a foliot, so the shortest wins. Last, because
   this is the one direction that is a guess.

The search never leaves a `geo` directory, so the worst case is finding nothing.

### What it adds

50 of the modpack corpus's 224 covered entities come this way — see the coverage table above for how
that sits against the code routes. What remains uncovered is mostly not mobs at all: spell projectiles,
`flying_item`, seats, camera entities, and lang keys that are category headers rather than types.

## Flags

```
rendermite blocks --version 1.21.1 --output ./pack
                  [--no-entities]         # skip entities.json entirely
                  [--no-entity-geometry]  # names and marker colours, no shapes
```
