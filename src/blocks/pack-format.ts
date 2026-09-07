/**
 * The shape of the JSON a block pack writes: what a consumer reads back.
 *
 * Types only, and deliberately separate from `export.ts`, which writes them but
 * cannot be imported by a browser — it pulls `sharp` in. A renderer needs the
 * format and the evaluation, not the exporter, so both live behind `./pack`.
 *
 * `export.ts` writes each file `satisfies` the type here, so the two cannot
 * drift: a field added to the emit without being added here fails to compile.
 */

import type { BiomeClimatePack } from './biomes.ts';
import type { BlockStateMultipartCase, BlockStateVariantCase } from './blockstate-eval.ts';
import type { MeshGroup } from './obj-mesh.ts';
import type { BlockTintPack } from './tints.ts';
import type {
	FaceDirectionName,
	ModelElementJson,
	Vec3,
	Vec4,
} from '../models/types.ts';

/** How a sprite's alpha classifies it, inferred because assets rarely say. */
export type BlockPackRenderLayer = 'solid' | 'cutout' | 'translucent';

export interface BlockPackFace {
	sprite: string;
	/** [u1, v1, u2, v2] in 0–16 sprite space, derived when the model omits it. */
	uv: Vec4;
	rotation?: number;
	tintindex?: number;
	cullface?: FaceDirectionName;
}

export interface BlockPackElement {
	from: Vec3;
	to: Vec3;
	rotation?: ModelElementJson['rotation'];
	shade?: false;
	faces: Partial<Record<FaceDirectionName, BlockPackFace>>;
}

export interface BlockPackModel {
	ao: boolean;
	elements: BlockPackElement[];
	/**
	 * The model's `particle` texture. What the game throws when the block breaks
	 * or is walked on, and the only colour a consumer has to work with for a
	 * block that draws nothing — a placeholder cube for a chest comes out oak
	 * rather than magenta.
	 */
	particle?: string;
	/** Triangle geometry from an OBJ loader, when the model uses one. */
	mesh?: MeshGroup[];
	/**
	 * The layer the model states it draws on. Authoritative where present, and
	 * it beats the per-sprite alpha inference — the same sprite can be solid in
	 * one model and translucent in another.
	 */
	renderType?: BlockPackRenderLayer;
	/** Block offsets a split-multiblock mesh spans. */
	multiblock?: Array<[number, number, number]>;
	/**
	 * Present when the block is a fluid, whose real surface height and flow
	 * direction come from its neighbours and so cannot be baked. The cube here is
	 * a stand-in; these are the sheets to mesh the real thing with.
	 */
	fluid?: { still: string; flow: string; overlay?: string; };
}

export interface BlockPackSpriteFrame {
	page: number;
	x: number;
	y: number;
	/** Duration in game ticks. */
	time: number;
}

export interface BlockPackSprite {
	page: number;
	x: number;
	y: number;
	w: number;
	h: number;
	layer: BlockPackRenderLayer;
	/** The displayed sequence, which can revisit a frame; absent when static. */
	frames?: BlockPackSpriteFrame[];
	interpolate?: true;
}

export interface BlockPackAtlasPage {
	file: string;
	width: number;
	height: number;
}

/** `atlas.json`. */
export interface BlockPackAtlasFile {
	/** Edge-extended border per sprite, in pixels. */
	padding: number;
	pages: BlockPackAtlasPage[];
	sprites: Record<string, BlockPackSprite>;
}

/** `models.json`, by fully-qualified model id. */
export type BlockPackModelsFile = Record<string, BlockPackModel>;

/** `blockstates.json`, by block id, with keys and predicates already parsed. */
export type BlockPackBlockStatesFile = Record<string, BlockPackBlockState>;

/**
 * A variant as the pack writes it. Every rotation is optional because the emit
 * drops each one at its default, which is most of them.
 */
export interface BlockPackVariant {
	model: string;
	x?: number;
	y?: number;
	z?: number;
	uvlock?: true;
	weight?: number;
}

/**
 * One block's cases as the pack writes them: what `evaluateBlockState` takes,
 * flattened to the key the file uses. Pass it as
 * `{ kind: 'variants', cases: state.variants }` and the models come back as
 * `BlockPackVariant`, no cast in either direction.
 */
export type BlockPackBlockState =
	| { variants: Array<BlockStateVariantCase<BlockPackVariant>>; multipart?: undefined; }
	| { multipart: Array<BlockStateMultipartCase<BlockPackVariant>>; variants?: undefined; };

/** `tints.json`. */
export type BlockPackTintsFile = BlockTintPack;

/**
 * How much light a block emits, 0–15.
 *
 * A number when every state of the block emits the same. Otherwise the commonest level is `default`
 * and each other level is a case naming only the properties that decide it: a redstone lamp is
 * `{ default: 0, cases: [{ when: { lit: 'true' }, level: 15 }] }`. The first case whose every
 * property matches the state applies; `blockLightLevel` in `light-eval.ts` does that lookup.
 */
export type BlockPackLight =
	| number
	| { default: number; cases: Array<{ when: Record<string, string>; level: number; }>; };

/**
 * `light.json`, by block id, holding only the blocks that emit: absent means 0. Present only when the
 * pack has emitters and the export could read the code for them — an `--assets` run has none.
 */
export type BlockPackLightFile = Record<string, BlockPackLight>;

/**
 * `biomes.json`, present only when the pack has biomes to describe: vanilla's
 * whole table, or the ones a mod's datapack declares. Absent is not empty — a
 * consumer with no file falls back to tinting at `tints.json`'s flat climate.
 */
export type BlockPackBiomesFile = BiomeClimatePack;

/** One flat sprite of an item's layer stack, in the order the client draws them. */
export interface ItemPackLayer {
	sprite: string;
	/**
	 * Present when the item declares a tint at this layer, which is the client's own
	 * rule: `ItemModelGenerator` passes each layer its own index as the tint index.
	 */
	tintindex?: number;
	/**
	 * The colour that tint resolves to in an item's default state, `#rrggbb`.
	 *
	 * Absent where it cannot be known from assets — a dyed leather boot or a potion
	 * takes its colour from the stack's components, which no pack can carry. A
	 * consumer drawing an absent tint untinted gets the mod's own artwork, which is
	 * the same thing the icon renderer settles for.
	 */
	tint?: string;
}

/** One flat item: everything there is to say about how the game draws it. */
export interface ItemPackEntry {
	layers: ItemPackLayer[];
}

/**
 * `items.json`. Self-contained rather than sharing `atlas.json`'s pages, so a
 * consumer that only draws blocks never fetches the item sheet at all — a world
 * viewer needs it only once it finds a dropped stack of something that is not a
 * block.
 *
 * Holds *only* items whose model is a flat sprite stack. An item absent from
 * `items` either draws from `blockstates.json` under the same id, or is in
 * `failures.json` saying why nothing can draw it.
 */
export interface BlockPackItemsFile {
	/** Edge-extended border per sprite, in pixels. */
	padding: number;
	pages: BlockPackAtlasPage[];
	sprites: Record<string, BlockPackSprite>;
	items: Record<string, ItemPackEntry>;
}

/**
 * One entity type: what to call it, and what colour it is.
 *
 * No geometry, because no jar has any — entity models are Java code at every version. What a consumer
 * can do with this is name the stand-in box it draws and tint it like the animal, which is the
 * difference between a field of arbitrary colours and a readable one.
 */
export interface EntityPackEntry {
	/** English display name, from the jar's own lang file. */
	name: string;
	/**
	 * Mean colour of the opaque pixels of the entity's sheet, `#rrggbb`.
	 *
	 * Absent for everything that is not a mob — an item entity, a falling block, a marker, a display,
	 * a thrown projectile — because those draw from an item or a block and have no sheet of their own.
	 * None is invented for them.
	 */
	color?: string;
	/**
	 * The sheet the colour came from, and what the model's `uv` values address. A sprite id in
	 * `entity-models.json`'s atlas once that file is present.
	 */
	texture?: string;
	/** Key into `entity-models.json`'s `models`, when geometry was recovered for this entity. */
	model?: string;
}

/**
 * `entities.json`, by entity id. The registry read off the lang file, which is the closest thing a jar
 * carries to it. Absent from a pack whose namespaces register no entities.
 */
export type BlockPackEntitiesFile = Record<string, EntityPackEntry>;

/** One box of a part, in the model's own space, exactly as the game's own builder stated it. */
/** The six faces a box can carry its own texture rect on. */
export type EntityPackCubeFace = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';

export interface EntityPackCube {
	/** Minimum corner. */
	origin: Vec3;
	size: Vec3;
	/** Texture offset in pixels on the entity's own sheet, as `texOffs` set it. */
	uv: [number, number];
	/** Grows the box on every side; `CubeDeformation`, or a builder's `delta`. */
	inflate?: number;
	mirror?: true;
	/**
	 * Per-face texture rects, which replace the box unwrap `uv` implies wherever they are present.
	 *
	 * Java has no such thing, since `addBox` always unwraps the same way, but bedrock geometry does and
	 * leans on it: 56% of the cubes across four GeckoLib mods state their faces individually. A consumer
	 * that ignores this draws over half of every such mob from the wrong part of its sheet.
	 */
	faces?: Partial<Record<EntityPackCubeFace, { uv: [number, number]; size: [number, number]; }>>;
}

/** One bone: where it pivots, what it is made of, and what hangs off it. */
export interface EntityPackPart {
	name: string;
	/** Pivot relative to the parent bone. */
	pivot: Vec3;
	/** Radians about x, y, z, as `PartPose.offsetAndRotation` states them. */
	rotation: Vec3;
	cubes: EntityPackCube[];
	children: EntityPackPart[];
}

/**
 * One entity model: a bone hierarchy of boxes, recovered from the client's own code.
 *
 * `textureSize` is the sheet the `uv` values are in, which is *not* the atlas page — a consumer maps
 * `uv` through it into the sprite's rect, exactly as it does for a block face.
 *
 * **Prefer the sprite's own `w`/`h` where the entity has one**, and keep this as the fallback. One
 * model can be drawn on two differently sized sheets: from 1.21.4 a boat and a chest boat are both a
 * `BoatModel`, on a 128x64 and a 128x128 sheet respectively, so no single value here is right for both.
 */
export interface EntityPackModel {
	textureSize: [number, number];
	parts: EntityPackPart[];
	/** Anything the extraction had to skip or assume, so a consumer can distrust it knowingly. */
	notes?: string[];
}

/**
 * `entity-models.json`. Self-contained like `items.json`, with its own atlas of entity sheets, so a
 * consumer that never draws a mob does not fetch any of it.
 *
 * `models` is keyed by the class the geometry came from, and `entities.json`'s `model` points at it —
 * several entities share one model (every zombie is a `HumanoidModel`), and keying by class is what
 * makes that one entry rather than twenty copies.
 */
export interface BlockPackEntityModelsFile {
	padding: number;
	pages: BlockPackAtlasPage[];
	sprites: Record<string, BlockPackSprite>;
	models: Record<string, EntityPackModel>;
	/** Worn armour, when the version's classes described any. Absent otherwise. */
	equipment?: EquipmentPack;
}

/** The armour slots the game dresses a humanoid in, in the order it layers them. */
export const EQUIPMENT_SLOTS = ['feet', 'legs', 'chest', 'head'] as const;
export type EquipmentSlot = typeof EQUIPMENT_SLOTS[number];

/**
 * Worn armour: one humanoid-shaped mesh, the two sizes it is drawn at, and a sheet per material.
 *
 * Armour is not geometry of its own — it is the wearer's own humanoid shape grown by a fixed amount,
 * which is why one mesh dresses a player, a zombie and an armour stand alike. The leggings are the
 * *inner* layer and everything else the *outer*, drawn a little larger so the two never fight.
 *
 * Everything a consumer needs to decide what to draw is stated here rather than derived, in keeping
 * with the rest of the pack: which parts a slot lights up, which sheet a material uses, and which
 * material an item is made of.
 */
export interface EquipmentPack {
	/** Key into `models`, holding the humanoid armour shape. */
	model: string;
	/** How much each layer grows the wearer's boxes by, in pixels. */
	inflate: { inner: number; outer: number; };
	/** Parts each slot shows. A slot lights up some of the one mesh rather than owning geometry. */
	slots: Record<EquipmentSlot, string[]>;
	/** Which layer a slot is drawn on, which decides the sheet as well as the size. */
	layerOf: Record<EquipmentSlot, 'inner' | 'outer'>;
	/** Sprite ids per material and layer, into this file's own `sprites`. */
	materials: Record<string, Partial<Record<'inner' | 'outer', string>>>;
	/**
	 * The armour items themselves. Keyed by item id because that is what a world writes into an
	 * entity's `equipment` compound, and nothing in the assets maps one to the other.
	 */
	items: Record<string, { material: string; slot: EquipmentSlot; }>;
	/** Materials whose sheet is greyscale and takes the item's own dye colour. */
	dyeable: string[];
	/** Worn armour-trim sheets generated from the version's armour-trim atlas. */
	trims: {
		/** Sprite ids per pattern and material, into this file's own `sprites`. */
		patterns: Record<string, Record<string, Partial<Record<'inner' | 'outer', string>>>>;
		/** Material a trim falls back to when it matches the armour it is on. */
		darker: Record<string, string>;
	};
}

/** `meta.json`, written last because it hashes every other file. */
export interface BlockPackMetaFile {
	generator: string;
	version: string;
	namespaces: string[];
	counts: {
		blocks: number;
		models: number;
		sprites: number;
		pages: number;
		/** Biomes in `biomes.json`; `0` means the pack has none and the file is absent. */
		biomes: number;
		/** Flat items in `items.json`; `0` means the pack has none and the file is absent. */
		items: number;
		/** Entity types in `entities.json`; `0` means the pack has none and the file is absent. */
		entities: number;
		/** Distinct entity models in `entity-models.json`; `0` means the file is absent. */
		entityModels: number;
		/** Emitting blocks in `light.json`; `0` means the file is absent. */
		light: number;
		failures: number;
	};
	/** sha256 per file, enough to verify a cached copy without refetching it. */
	hashes: Record<string, string>;
}
