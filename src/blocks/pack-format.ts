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
 * `biomes.json`, present only when the pack has biomes to describe: vanilla's
 * whole table, or the ones a mod's datapack declares. Absent is not empty — a
 * consumer with no file falls back to tinting at `tints.json`'s flat climate.
 */
export type BlockPackBiomesFile = BiomeClimatePack;

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
		failures: number;
	};
	/** sha256 per file, enough to verify a cached copy without refetching it. */
	hashes: Record<string, string>;
}
