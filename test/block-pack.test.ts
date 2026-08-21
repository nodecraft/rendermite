/**
 * Block pack export across the supported range. The floor is 1.13.2 (the
 * Flattening) and the cases bracket the two things that actually change between
 * then and now: `atlases/` arriving in 1.19.3, and the `models` → `modern` era
 * boundary at 1.21.4.
 *
 * The load-bearing assertion is the last one in every case: nothing may land in
 * the failures sidecar except the kinds that are statements about the assets
 * rather than about the exporter — a block the game draws in code, and the tint
 * indices vanilla itself leaves alone. A dropped model, an unresolved sprite or a
 * tintindex the table has no answer for fails here.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ensureModrinthJar, vanillaJar } from './fixtures/index.ts';
import { VANILLA_BIOME_CLIMATES } from '../src/blocks/biomes.ts';
import { exportBlockPack } from '../src/blocks/export.ts';
import { builtinPackPath } from '../src/builtin.ts';
import { prepareModResources } from '../src/mods/prepare.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { prepareVersionResources } from '../src/versions/prepare.ts';

import type { BlockPackResult } from '../src/blocks/export.ts';
import type { ResourceManager } from '../src/resources/manager.ts';

const packRoot = path.join(import.meta.dirname, '..', '.work', 'block-packs');

/**
 * Kinds that describe the assets, not a failure of the exporter.
 *
 * `tint` is deliberately *not* one of them. A vanilla tintindex with no entry in
 * the table is a block that draws grey where the game draws it green — which is
 * how 1.21.5's leaf litter and bushes went a release unnoticed — so the ones
 * vanilla really does leave untinted are named in `UNREGISTERED_TINTS` and
 * recorded as `intentional`, and anything else here fails the run.
 */
const ASSET_KINDS = new Set(['geometry', 'intentional']);

/**
 * Failure shapes that are true statements about *any* pack's assets, vanilla
 * included. Spelled out by reason rather than waved through as a whole kind, for
 * the same reason `tint` is not in `ASSET_KINDS`.
 */
const ASSET_ALLOWANCES: Array<{ kind: string; reason: RegExp; }> = [
	// An item that is neither a flat sprite stack nor a block: vanilla's shield and
	// spyglass, drawn by the game from geometry the item sheet cannot carry. Named
	// so that anything *else* landing in the item sheet's failures is a real gap.
	{ kind: 'item', reason: /^item model is not a flat sprite stack and the pack describes no block of this id$/ },
];

/**
 * Mods break their own assets in ways vanilla never does, and the pack's answer
 * to each is a deliberate one. Every shape below is "the mod's files say this",
 * spelled out rather than waved through as a whole kind — a `model` entry for a
 * parse failure, or a `texture` one for anything but the missing-sprite
 * substitution, is still a bug and still fails the run.
 */
const MODDED_ALLOWANCES: Array<{ kind: string; reason: RegExp; }> = [
	// A blockstate naming a model the mod builds in Java rather than shipping.
	{ kind: 'model', reason: /^Model not found: / },
	// A texture the mod never bound or never shipped; the face keeps the
	// missing-texture sprite, as the game draws it.
	{ kind: 'texture', reason: /missing-texture sprite$|^every face uses the missing-texture sprite/ },
	{ kind: 'sprite', reason: /^texture not found$/ },
	// One unusable case out of many, a blockstate a loader defines, or a block
	// whose every model the mod builds in Java — the block-level statement of
	// the `Model not found` entries above.
	{ kind: 'blockstate', reason: /case dropped$|^a loader defines this blockstate|^every case named a model that could not be exported$/ },
	// A mod registers its block colours in Java, so the tint table can only ever
	// cover vanilla's. Recorded, and the block draws untinted rather than not at all.
	{ kind: 'tint', reason: /^tintindex \d+ is not in the tint table/ },
	/*
	 * The item sheet's own version of the above: a mod naming a layer texture it
	 * never shipped, a generated model with nothing in it, and the knock-on entry
	 * for an item whose sprite therefore has no rect. Each is the mod's files
	 * saying so, and each leaves the item to be drawn as a box rather than wrong.
	 */
	{ kind: 'item', reason: /resolves to no texture; layer dropped$/ },
	{ kind: 'item', reason: /^generated item model states no layers$/ },
	{ kind: 'item', reason: /has no atlas rect; item dropped$/ },
	{ kind: 'item', reason: /^No item definition or item model for / },
];

function unexpectedFailures(pack: Pack, modded = false): BlockPackResult['failures'] {
	return pack.result.failures.filter((failure) => {
		if (ASSET_KINDS.has(failure.kind)) {
			return false;
		}
		const matches = (allowed: { kind: string; reason: RegExp; }): boolean => allowed.kind === failure.kind && allowed.reason.test(failure.reason);
		if (ASSET_ALLOWANCES.some(matches)) {
			return false;
		}
		return !modded || !MODDED_ALLOWANCES.some(matches);
	});
}

interface AtlasJson {
	padding: number;
	pages: Array<{ file: string; width: number; height: number; }>;
	sprites: Record<string, { page: number; x: number; y: number; w: number; h: number; layer: string; frames?: Array<{ time: number; }>; interpolate?: true; }>;
}

interface ModelsJson {
	[id: string]: {
		ao: boolean;
		elements: Array<{
			from: number[];
			to: number[];
			rotation?: { angle: number; };
			faces: Record<string, { sprite: string; uv: number[]; tintindex?: number; }>;
		}>;
		mesh?: Array<{ sprite: string; object?: string; positions: number[]; uv: number[]; }>;
		particle?: string;
		renderType?: string;
		multiblock?: number[][];
		fluid?: { still: string; flow: string; overlay?: string; };
	};
}

interface BlockStatesJson {
	[id: string]: {
		variants?: Array<{ when: Record<string, string>; apply: Array<{ model: string; x?: number; y?: number; z?: number; }>; }>;
		multipart?: Array<{ when: unknown; apply: Array<{ model: string; }>; }>;
	};
}

interface Pack {
	result: BlockPackResult;
	directory: string;
	atlas: AtlasJson;
	models: ModelsJson;
	blockStates: BlockStatesJson;
	meta: { counts: Record<string, number>; hashes: Record<string, string>; };
	tints: { flat: Record<string, string>; blocks: Record<string, Record<string, { kind: string; }>>; };
	/** `biomes.json`, which a pack with no biomes to describe does not write at all. */
	biomes: Record<string, { temperature: number; downfall: number; water?: string; modifier?: string; grass?: string; foliage?: string; dryFoliage?: string; }> | null;
	/** `items.json`, likewise absent from a pack with no flat items. */
	items: {
		padding: number;
		pages: Array<{ file: string; width: number; height: number; }>;
		sprites: Record<string, { page: number; x: number; y: number; w: number; h: number; }>;
		items: Record<string, { layers: Array<{ sprite: string; tintindex?: number; tint?: string; }>; }>;
	} | null;
}

async function exportPack(name: string, resources: ResourceManager, namespaces?: string[]): Promise<Pack> {
	const directory = path.join(packRoot, name);
	// The vendored pack is what gives chests, shulker boxes and signs a shape.
	const result = await exportBlockPack({ resources, output: directory, version: name, namespaces, builtin: builtinPackPath('modern') });
	const read = async <T>(file: string): Promise<T> => JSON.parse(await readFile(path.join(directory, file), 'utf8')) as T;
	return {
		result,
		directory,
		atlas: await read<AtlasJson>('atlas.json'),
		models: await read<ModelsJson>('models.json'),
		blockStates: await read<BlockStatesJson>('blockstates.json'),
		meta: await read<Pack['meta']>('meta.json'),
		tints: await read<Pack['tints']>('tints.json'),
		biomes: existsSync(path.join(directory, 'biomes.json')) ? await read<NonNullable<Pack['biomes']>>('biomes.json') : null,
		items: existsSync(path.join(directory, 'items.json')) ? await read<NonNullable<Pack['items']>>('items.json') : null,
	};
}

function referencedModels(pack: Pack): string[] {
	return Object.values(pack.blockStates)
		.flatMap(definition => definition.variants ?? definition.multipart ?? [])
		.flatMap(entry => entry.apply.map(variant => variant.model));
}

function referencedSprites(pack: Pack): string[] {
	return Object.values(pack.models).flatMap(model => [
		...model.elements.flatMap(element => Object.values(element.faces).map(face => face.sprite)),
		...(model.mesh ?? []).map(group => group.sprite),
		...(model.particle === undefined ? [] : [model.particle]),
	]);
}

/** Blocks whose every case resolves to a model with nothing to draw. */
function emptyBlocks(pack: Pack): string[] {
	return Object.entries(pack.blockStates)
		.filter(([, definition]) => (definition.variants ?? definition.multipart ?? [])
			.every(entry => entry.apply.every((apply) => {
				const model = pack.models[apply.model];
				return model === undefined || (model.elements.length === 0 && !model.mesh?.length);
			})))
		.map(([id]) => id);
}

/** Shared structural guarantees, asserted for vanilla and modded packs alike. */
function assertSelfContained(pack: Pack): void {
	for (const model of new Set(referencedModels(pack))) {
		expect(pack.models, `blockstates name ${model}`).toHaveProperty([model]);
	}
	for (const sprite of new Set(referencedSprites(pack))) {
		expect(pack.atlas.sprites, `models name ${sprite}`).toHaveProperty([sprite]);
	}
	for (const sprite of Object.values(pack.atlas.sprites)) {
		const page = pack.atlas.pages[sprite.page];
		expect(page).toBeDefined();
		expect(sprite.x + sprite.w + pack.atlas.padding).toBeLessThanOrEqual(page.width);
		expect(sprite.y + sprite.h + pack.atlas.padding).toBeLessThanOrEqual(page.height);
	}
	for (const page of pack.atlas.pages) {
		expect(Number.isSafeInteger(Math.log2(page.width))).toBe(true);
		expect(Number.isSafeInteger(Math.log2(page.height))).toBe(true);
	}
	if (pack.items) {
		// The item sheet is its own atlas, so it carries its own version of every
		// guarantee above: a dangling layer sprite draws a hole where an item was.
		for (const [id, entry] of Object.entries(pack.items.items)) {
			expect(entry.layers.length, `${id} has layers`).toBeGreaterThan(0);
			for (const layer of entry.layers) {
				expect(pack.items.sprites, `${id} names ${layer.sprite}`).toHaveProperty([layer.sprite]);
			}
		}
		for (const sprite of Object.values(pack.items.sprites)) {
			const page = pack.items.pages[sprite.page];
			expect(page).toBeDefined();
			expect(sprite.x + sprite.w + pack.items.padding).toBeLessThanOrEqual(page.width);
			expect(sprite.y + sprite.h + pack.items.padding).toBeLessThanOrEqual(page.height);
		}
	}
}

interface VersionCase {
	version: string;
	/** Floors, so a regression that drops half the blocks fails loudly. */
	blocks: number;
	models: number;
	sprites: number;
	/** Flat items in `items.json`; a floor for the same reason. */
	items: number;
}

const CASES: VersionCase[] = [
	// The floor. No `atlases/` and no items/ definitions, but fully namespaced.
	{ version: '1.13.2', blocks: 550, models: 850, sprites: 460, items: 450 },
	// Immediately below the atlases/ introduction — the empty resolver is correct.
	{ version: '1.18.2', blocks: 850, models: 1450, sprites: 720, items: 580 },
	// Immediately above it.
	{ version: '1.19.4', blocks: 950, models: 1650, sprites: 790, items: 620 },
	// Either side of the models → modern era boundary.
	{ version: '1.21.1', blocks: 1000, models: 1800, sprites: 900, items: 950 },
	{ version: '1.21.4', blocks: 1040, models: 1850, sprites: 930, items: 1000 },
	// Current.
	{ version: '26.2', blocks: 1140, models: 2200, sprites: 1140, items: 1150 },
];

describe.each(CASES)('block pack for $version', (testCase) => {
	it('exports a self-contained pack with no silent drops', { timeout: 180000 }, async () => {
		const resources = await prepareVersionResources({
			version: testCase.version,
			jar: vanillaJar(testCase.version),
		});
		const pack = await exportPack(testCase.version, resources);

		expect(pack.result.blocks).toBeGreaterThanOrEqual(testCase.blocks);
		expect(pack.result.models).toBeGreaterThanOrEqual(testCase.models);
		expect(pack.result.sprites).toBeGreaterThanOrEqual(testCase.sprites);
		expect(pack.result.items).toBeGreaterThanOrEqual(testCase.items);
		// Vanilla stitches into one page across the whole range; a second one would
		// mean the packer or the sprite set changed shape.
		expect(pack.result.pages).toBe(1);
		// Every file plus meta.json itself, which hashes the rest.
		expect(pack.result.writtenFiles).toBe(Object.keys(pack.meta.hashes).length + 1);

		assertSelfContained(pack);

		// Sprites the consumer is promised whether or not a model names them:
		// the missing-texture fallback for anything the pack cannot describe,
		// and the fluid textures, since water and lava are blocks here but the
		// game meshes them in code and their models state nothing.
		expect(pack.atlas.sprites['minecraft:missingno']).toBeDefined();
		for (const fluid of ['water_still', 'water_flow', 'water_overlay', 'lava_still', 'lava_flow']) {
			expect(pack.atlas.sprites, fluid).toHaveProperty([`minecraft:block/${fluid}`]);
		}

		/*
		 * The item sheet exists to draw a dropped stack of something that is not a
		 * block. A lead is the canonical one — flat, single-layer, in every version —
		 * and a stone is the canonical counter-example: it must be absent, so the
		 * consumer falls through to `blockstates.json` and draws the cube.
		 */
		expect(pack.items).not.toBeNull();
		expect(pack.items?.items['minecraft:lead']?.layers)
			.toStrictEqual([{ sprite: 'minecraft:item/lead' }]);
		expect(pack.items?.items).not.toHaveProperty(['minecraft:stone']);
		expect(pack.items?.items).not.toHaveProperty(['minecraft:oak_planks']);
		/*
		 * Wheat is why the item model has to win over the block model rather than the
		 * other way round: the item is a flat sheaf and the block of the same id is a
		 * crop cross, and a consumer preferring the block draws a dropped sheaf as a
		 * plant.
		 */
		expect(pack.items?.items['minecraft:wheat']?.layers)
			.toStrictEqual([{ sprite: 'minecraft:item/wheat' }]);
		// Its own pages, never the block atlas's: the point is that a consumer
		// drawing only blocks never fetches the item sheet at all.
		for (const page of pack.items?.pages ?? []) {
			expect(page.file).toMatch(/^item-atlas-\d+\.png$/);
		}

		// Vendored geometry is a guess about a block the assets do not describe.
		// A half-bound one reads as a broken texture rather than a gap, so it is
		// dropped instead: nothing substituted may be part magenta.
		for (const [id, model] of Object.entries(pack.models)) {
			if (!id.startsWith('rendermite:')) {
				continue;
			}
			const sprites = model.elements.flatMap(element => Object.values(element.faces).map(face => face.sprite));
			expect(sprites, id).not.toContain('minecraft:missingno');
		}

		// Every version is fully covered: the only blocks that draw nothing are the
		// ones the game itself draws nothing for. Anything else appearing here is
		// a block a world viewer would put a hole in.
		const intentional = new Set(pack.result.failures
			.filter(failure => failure.kind === 'intentional')
			.map(failure => failure.id));
		expect(emptyBlocks(pack).filter(id => !intentional.has(id))).toEqual([]);

		// Plains tints come out of the version's own colormaps.
		expect(pack.tints.flat.grass).toMatch(/^#[\da-f]{6}$/);
		expect(pack.tints.flat.foliage).toMatch(/^#[\da-f]{6}$/);

		/*
		 * Every biome the version can put in a chunk, so the consumer tints a swamp
		 * grey-green rather than every biome as a plains. The climates are not in any
		 * jar — they are code in the game — so this is the transcribed table, and what
		 * matters is that it reaches the pack and says what the game says.
		 */
		expect(pack.biomes, 'biomes.json').not.toBeNull();
		const biomes = pack.biomes as NonNullable<Pack['biomes']>;
		expect(biomes['minecraft:plains']).toEqual({ temperature: 0.8, downfall: 0.4 });
		expect(biomes['minecraft:swamp']).toMatchObject({ modifier: 'swamp', water: '#617b64' });
		expect(pack.meta.counts.biomes).toBe(Object.keys(biomes).length);

		/*
		 * The tint table is this version's, not the union of every version: a climate
		 * kind it names has to have a colour in the same pack, and a block it names has
		 * to be one this version actually has.
		 */
		for (const [id, indices] of Object.entries(pack.tints.blocks)) {
			expect(pack.blockStates, `${id} is tinted`).toHaveProperty([id]);
			for (const [index, tint] of Object.entries(indices)) {
				if (['grass', 'foliage', 'dry_foliage'].includes(tint.kind)) {
					expect(pack.tints.flat[tint.kind], `${id} tintindex ${index}`).toMatch(/^#[\da-f]{6}$/);
				}
			}
		}

		// meta.json is what the consumer caches on, so its hashes must be real.
		for (const [file, hash] of Object.entries(pack.meta.hashes)) {
			const bytes = await readFile(path.join(pack.directory, file));
			expect(createHash('sha256').update(bytes).digest('hex'), file).toBe(hash);
		}

		expect(unexpectedFailures(pack)).toEqual([]);
	});
});

describe('block pack contents', () => {
	it('carries variants, multipart, animation and layers through', { timeout: 180000 }, async () => {
		const resources = await prepareVersionResources({ version: '26.2', jar: vanillaJar('26.2') });
		const pack = await exportPack('26.2', resources);

		// A weighted variant list emits whole; taking the first would leave grass
		// with one rotation instead of four.
		const grass = pack.blockStates['minecraft:grass_block'].variants
			?.find(entry => entry.when.snowy === 'false');
		expect(grass?.apply).toHaveLength(4);

		// Multipart is several models at once; emitting only the first match
		// produces fences with no posts.
		const fence = pack.blockStates['minecraft:oak_fence'].multipart;
		expect(fence?.length).toBeGreaterThan(4);
		expect(fence?.filter(part => part.when === null)).toHaveLength(1);

		// Stairs are the exact-key case the icon path's guess cannot answer.
		const stairs = pack.blockStates['minecraft:oak_stairs'].variants ?? [];
		expect(stairs.some(entry => entry.when.facing === 'east' && entry.when.half === 'top')).toBe(true);

		// Alpha decides the layer, and every animation frame gets its own rect.
		expect(pack.atlas.sprites['minecraft:block/stone'].layer).toBe('solid');
		const water = pack.atlas.sprites['minecraft:block/water_still'];
		expect(water.layer).toBe('translucent');
		expect(water.frames?.length).toBeGreaterThan(8);
		expect(water.frames?.every(frame => frame.time > 0)).toBe(true);
		expect(pack.atlas.sprites['minecraft:block/oak_sapling'].layer).toBe('cutout');

		// A face's UV is derived when the model omits one, in vanilla's own
		// convention: a bottom slab's side samples the planks' top half.
		expect(pack.models['minecraft:block/oak_slab'].elements[0].faces.north.uv).toEqual([0, 8, 16, 16]);

		expect(pack.tints.blocks['minecraft:grass_block']['0'].kind).toBe('grass');
		expect(pack.tints.blocks['minecraft:oak_leaves']['0'].kind).toBe('foliage');
		/*
		 * The blocks 1.21.5 added, each of which the wiki's own colour tables and the
		 * blocks' item definitions agree on. A bush reads the *grass* map rather than the
		 * dry-foliage one it sounds like it should, and leaf litter is the only block in
		 * the game that reads the dry-foliage map at all.
		 */
		expect(pack.tints.blocks['minecraft:bush']['0'].kind).toBe('grass');
		expect(pack.tints.blocks['minecraft:leaf_litter']['0'].kind).toBe('dry_foliage');
		// Stems only: the flowers above them are untinted, so the tint sits on index 1
		// and reading index 0 finds nothing. Nothing else in vanilla numbers a tint.
		expect(pack.tints.blocks['minecraft:pink_petals']).toEqual({ 1: { kind: 'grass' } });
		expect(pack.tints.blocks['minecraft:wildflowers']).toEqual({ 1: { kind: 'grass' } });
		// An empty cauldron holds no water to colour, unlike the water one.
		expect(pack.tints.blocks['minecraft:water_cauldron']['0'].kind).toBe('water');
		expect(pack.tints.blocks['minecraft:cauldron']).toBeUndefined();
	});

	it('takes biome climates from the jar where the version ships them', { timeout: 240000 }, async () => {
		/*
		 * 1.19.3 is where a client jar started carrying `data/minecraft/worldgen/biome/`, and where it
		 * does those values are the version's own answer rather than a transcription of a later one. The
		 * pair below is the whole rule: 1.19.4 states a swamp with no dry-foliage colour, because dry
		 * foliage did not exist yet, while the table this exporter carries does state one — and 1.18.2,
		 * whose jar has no biome data at all, comes out as the table exactly.
		 */
		const modern = await exportPack('1.19.4-biomes', await prepareVersionResources({
			version: '1.19.4',
			jar: vanillaJar('1.19.4'),
		}));
		expect(VANILLA_BIOME_CLIMATES['minecraft:swamp'].dryFoliage).toBeDefined();
		expect(modern.biomes?.['minecraft:swamp']).toBeDefined();
		expect(modern.biomes?.['minecraft:swamp'].dryFoliage).toBeUndefined();
		expect(modern.biomes?.['minecraft:swamp']).toMatchObject({ modifier: 'swamp', water: '#617b64' });

		const legacy = await exportPack('1.18.2-biomes', await prepareVersionResources({
			version: '1.18.2',
			jar: vanillaJar('1.18.2'),
		}));
		expect(legacy.biomes?.['minecraft:swamp']).toEqual(VANILLA_BIOME_CLIMATES['minecraft:swamp']);
	});

	it('gives blocks the game draws in code a shape and an orientation', { timeout: 180000 }, async () => {
		// 1.21.8 rather than current: 26.2 ships real sign models, and the
		// substitution has to stand down where the assets grow geometry of their
		// own. That is asserted at the end.
		const resources = await prepareVersionResources({ version: '1.21.8', jar: vanillaJar('1.21.8') });
		const pack = await exportPack('1.21.8', resources);

		// A chest's blockstate is one empty-key variant on a model with no
		// elements, so the shape, the facing and the pairing are all substituted:
		// three forms times four facings.
		const chest = pack.blockStates['minecraft:chest'].variants ?? [];
		expect(chest).toHaveLength(12);
		expect(new Set(chest.map(entry => entry.when.type))).toEqual(new Set(['single', 'left', 'right']));
		expect(chest.filter(entry => entry.when.type === 'single')
			.map(entry => entry.when.facing).toSorted((left, right) => left.localeCompare(right)))
			.toEqual(['east', 'north', 'south', 'west']);
		const chestModel = chest[0].apply[0].model;
		expect(chestModel).toMatch(/^rendermite:block\//);
		expect(pack.models[chestModel].elements.length).toBeGreaterThanOrEqual(3);
		// Each facing is a distinct rotation of the one model.
		expect(new Set(chest.filter(entry => entry.when.type === 'single').map(entry => entry.apply[0].y ?? 0)).size).toBe(4);

		// The two halves of a double chest have to meet exactly: each is 15 wide
		// against a single's 14, offset opposite ways so they abut, and each
		// drops the face on the seam so it does not fight the partner's.
		const half = (type: string): ModelsJson[string] => pack.models[`rendermite:block/chest_${type}`];
		for (const type of ['left', 'right']) {
			const body = half(type).elements[0];
			expect(body.to[0] - body.from[0], type).toBe(15);
			expect(Object.keys(body.faces), type).not.toContain(type === 'left' ? 'west' : 'east');
			expect(Object.keys(body.faces), type).toContain(type === 'left' ? 'east' : 'west');
		}
		// Left grows west into the seam, right grows east, so placing them one
		// block apart leaves neither a gap nor an overlap.
		expect(half('left').elements[0].from[0]).toBe(0);
		expect(half('right').elements[0].from[0]).toBe(1);
		// An ender chest never doubles and ships no paired sheets, so it keeps
		// only the single form rather than substituting a magenta one.
		expect(pack.blockStates['minecraft:ender_chest'].variants).toHaveLength(4);
		expect(pack.models['rendermite:block/chest_left']).toBeDefined();

		// Signs are the biggest family and had no vendored geometry until now.
		expect(pack.models['rendermite:block/oak_sign'].elements).toHaveLength(2);
		expect(pack.blockStates['minecraft:oak_sign'].variants).toHaveLength(16);
		expect(pack.models['rendermite:block/oak_wall_sign'].elements).toHaveLength(1);
		expect(pack.models['rendermite:block/oak_hanging_sign'].elements.length).toBeGreaterThan(2);
		expect(pack.blockStates['minecraft:oak_wall_hanging_sign'].variants).toHaveLength(4);

		// Shulker boxes orient on all six faces.
		expect(pack.blockStates['minecraft:red_shulker_box'].variants).toHaveLength(6);

		// A bed is two blocks with a model each, so `part` multiplies with
		// `facing` into eight cases over two substituted models.
		const bed = pack.blockStates['minecraft:red_bed'].variants ?? [];
		expect(bed).toHaveLength(8);
		expect(new Set(bed.map(entry => entry.apply[0].model))).toEqual(new Set([
			'rendermite:block/red_bed_head',
			'rendermite:block/red_bed_foot',
		]));
		expect(bed.every(entry => entry.when.part && entry.when.facing)).toBe(true);

		// A banner's 16 colours are one greyscale sheet under a dye, so they cost
		// one model and a tint rather than 16 models.
		expect(pack.blockStates['minecraft:red_banner'].variants).toHaveLength(16);
		expect(pack.blockStates['minecraft:red_wall_banner'].variants).toHaveLength(4);
		expect(pack.tints.blocks['minecraft:red_banner']).toEqual({ 0: { kind: 'constant', color: '#b02e26' } });
		const cloth = pack.models['rendermite:block/red_banner'].elements
			.find(element => Object.values(element.faces).some(face => face.tintindex !== undefined));
		expect(cloth, 'the banner cloth carries the tint, the post does not').toBeDefined();

		// Skulls reuse the mobheads geometry, which is centred for an item's
		// hand; a floor skull drops to the ground and a wall one moves back.
		expect(pack.blockStates['minecraft:skeleton_skull'].variants).toHaveLength(16);
		expect(pack.blockStates['minecraft:skeleton_wall_skull'].variants).toHaveLength(4);
		expect(pack.models['rendermite:block/skeleton_skull'].elements[0].from[1]).toBe(0);
		expect(pack.models['rendermite:block/skeleton_wall_skull'].elements[0].from[2]).toBe(8);

		// Water and lava are cubes with the right sprite, so a naive consumer
		// gets an ocean rather than a hole. A fluid's real surface height and
		// flow direction come from its neighbours, so the cube is a stand-in and
		// the model names the sheets to mesh the real thing with.
		expect(pack.blockStates['minecraft:water'].variants).toHaveLength(1);
		const water = pack.models['rendermite:block/water'];
		expect(water.elements[0].to).toEqual([16, 16, 16]);
		expect(water.elements[0].faces.up.tintindex).toBe(0);
		expect(pack.models['rendermite:block/lava'].elements[0].faces.up.tintindex).toBeUndefined();
		// `LiquidBlockRenderer` puts the still sheet on the flat faces and the
		// flow sheet on the sides, sampling its top-left quarter.
		expect(water.elements[0].faces.up.sprite).toBe('minecraft:block/water_still');
		expect(water.elements[0].faces.north.sprite).toBe('minecraft:block/water_flow');
		expect(water.elements[0].faces.north.uv).toEqual([0, 0, 8, 8]);
		expect(water.fluid).toEqual({
			still: 'minecraft:block/water_still',
			flow: 'minecraft:block/water_flow',
			overlay: 'minecraft:block/water_overlay',
		});
		// Only water has an overlay; deriving it as a sibling of the still sheet
		// is what stops lava borrowing water's.
		expect(pack.models['rendermite:block/lava'].fluid?.overlay).toBeUndefined();
		expect(pack.models['rendermite:block/lava'].fluid?.flow).toBe('minecraft:block/lava_flow');

		// By 1.21.8 the only vanilla blocks left empty are the ones the game
		// itself draws nothing for.
		const declared = new Set(pack.result.failures.filter(failure => failure.kind === 'intentional').map(failure => failure.id));
		expect(emptyBlocks(pack).filter(id => !declared.has(id))).toEqual([]);
		expect(declared).toContain('minecraft:air');
		expect(declared).toContain('minecraft:end_portal');

		// Substituted geometry is an approximation and the pack says so.
		expect(pack.result.failures.some(failure => failure.id === 'minecraft:chest' && failure.reason.includes('substitutes vendored geometry'))).toBe(true);
	});

	it('defers to the assets where a version grows real geometry', { timeout: 180000 }, async () => {
		// 26.2 ships `block/oak_sign_rot_0` and friends, with the rotation
		// variants vanilla never used to carry. Substituting over that would
		// replace the game's own shape with an approximation of it.
		const resources = await prepareVersionResources({ version: '26.2', jar: vanillaJar('26.2') });
		const pack = await exportPack('26.2', resources);
		expect(pack.blockStates['minecraft:oak_sign'].variants?.[0].apply[0].model).toMatch(/^minecraft:/);
		expect(Object.keys(pack.models).filter(id => id.startsWith('rendermite:block/') && id.includes('sign'))).toEqual([]);
		// Chests are still code-drawn even in the newest version.
		expect(pack.models['rendermite:block/chest_single']).toBeDefined();

		// 26.2's copper golem statue is drawn entirely from Java: an empty variant
		// on a model with only a particle texture, and no entity geometry in the
		// jar either. Its boxes were read off the sheet's own unwrap, and the head
		// is pinned by the vendored head item that shares the sheet.
		const statue = pack.blockStates['minecraft:copper_golem_statue'].variants ?? [];
		expect(statue).toHaveLength(4);
		expect(statue.map(entry => entry.when.facing).toSorted((left, right) => left.localeCompare(right)))
			.toEqual(['east', 'north', 'south', 'west']);
		// Keyed on facing alone, so all four `copper_golem_pose` values draw the
		// standing statue rather than nothing.
		expect(statue.every(entry => entry.when.copper_golem_pose === undefined)).toBe(true);
		const golem = pack.models['rendermite:block/copper_golem_statue'];
		expect(golem.elements).toHaveLength(10);
		expect(golem.elements[6].faces.north.sprite).toBe('minecraft:entity/copper_golem/copper_golem_eyes');
		// Waxing freezes the weathering stage rather than changing how it looks.
		const waxed = pack.models['rendermite:block/waxed_oxidized_copper_golem_statue'];
		expect(waxed.elements[0].faces.north.sprite).toBe('minecraft:entity/copper_golem/copper_golem_oxidized');
	});

	it('leaves code-drawn blocks empty when the vendored pack is not supplied', { timeout: 180000 }, async () => {
		const resources = await prepareVersionResources({ version: '26.2', jar: vanillaJar('26.2') });
		const directory = path.join(packRoot, 'no-builtin');
		const result = await exportBlockPack({ resources, output: directory, version: '26.2' });
		const models = JSON.parse(await readFile(path.join(directory, 'models.json'), 'utf8')) as ModelsJson;
		expect(Object.keys(models).some(id => id.startsWith('rendermite:'))).toBe(false);
		expect(result.failures.some(failure => failure.reason === 'model has no drawable elements')).toBe(true);
	});
});

describe('atlas ceiling', () => {
	it('points faces at the missing sprite when one is too large to pack', async () => {
		// The consumer only has atlas.json to resolve a sprite id with, so a sprite
		// that never got a rect has to stop being named by any model.
		const texture = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 20, g: 30, b: 40, alpha: 1 } } })
			.png()
			.toBuffer();
		const resources = new MapResourceManager()
			.set('blockstate', 'test:big', JSON.stringify({ variants: { '': { model: 'test:block/big' } } }))
			.set('model', 'test:block/big', JSON.stringify({
				textures: { all: 'test:block/big' },
				elements: [{
					from: [0, 0, 0],
					to: [16, 16, 16],
					faces: Object.fromEntries(['down', 'up', 'north', 'south', 'west', 'east'].map(name => [name, { texture: '#all' }])),
				}],
			}))
			.set('texture', 'test:block/big', texture);

		const directory = path.join(packRoot, 'oversized');
		// 64 leaves room for the 16x16 missing sprite and its padding, nothing more.
		const result = await exportBlockPack({ resources, output: directory, version: 'oversized', namespaces: ['test'], maxPageSize: 64 });
		const atlas = JSON.parse(await readFile(path.join(directory, 'atlas.json'), 'utf8')) as AtlasJson;
		const models = JSON.parse(await readFile(path.join(directory, 'models.json'), 'utf8')) as ModelsJson;

		expect(result.failures.some(failure => failure.id === 'test:block/big' && failure.reason.startsWith('sprite is larger'))).toBe(true);
		expect(atlas.sprites['test:block/big']).toBeUndefined();
		for (const face of Object.values(models['test:block/big'].elements[0].faces)) {
			expect(face.sprite).toBe('minecraft:missingno');
		}
		expect(atlas.sprites['minecraft:missingno']).toBeDefined();
	});
});

const online = process.env.RENDERMITE_SKIP_ONLINE !== '1';

describe.skipIf(!online)('modded block pack', () => {
	it('exports five large mods loaded together', { timeout: 600000 }, async () => {
		// Loaded as one modpack rather than one at a time, which is how a server
		// runs them and what the atlas packer has to cope with.
		const jars = await Promise.all([
			ensureModrinthJar({ slug: 'create', gameVersion: '1.20.1', loader: 'forge', versionNumber: 'mc1.20.1-6.0.8' }),
			ensureModrinthJar({ slug: 'immersiveengineering', gameVersion: '1.20.1', loader: 'forge' }),
			ensureModrinthJar({ slug: 'mekanism', gameVersion: '1.20.1', loader: 'forge' }),
			ensureModrinthJar({ slug: 'ae2', gameVersion: '1.20.1', loader: 'forge' }),
			ensureModrinthJar({ slug: 'botania', gameVersion: '1.20.1', loader: 'forge' }),
		]);
		const namespaces = ['create', 'immersiveengineering', 'mekanism', 'ae2', 'botania'];
		const vanilla = await prepareVersionResources({ version: '1.20.4', jar: vanillaJar('1.20.4') });
		const prepared = await prepareModResources({ jars, vanilla });
		try {
			const pack = await exportPack('mods', prepared.resources, namespaces);
			expect(pack.result.blocks).toBeGreaterThan(1800);
			expect(new Set(Object.keys(pack.blockStates).map(id => id.split(':', 1)[0]))).toEqual(new Set(namespaces));
			assertSelfContained(pack);
			// Create's pipes and windows are the multipart-heavy case.
			expect(Object.values(pack.blockStates).filter(definition => definition.multipart).length).toBeGreaterThan(50);

			// OBJ geometry is the largest class of modded block geometry a box-only
			// format could not carry: Create's crushing wheels and blaze burners,
			// IE's slopes, connectors and split multiblocks.
			const meshes = Object.values(pack.models).filter(model => model.mesh?.length);
			expect(meshes.length).toBeGreaterThan(60);
			for (const model of meshes) {
				for (const group of model.mesh ?? []) {
					expect(group.positions.length % 9).toBe(0);
					expect(group.uv.length).toBe(group.positions.length / 3 * 2);
				}
			}
			// A mesh-only model must not be reported as having nothing to draw.
			const meshIds = new Set(Object.entries(pack.models).filter(([, model]) => model.mesh?.length).map(([id]) => id));
			for (const failure of pack.result.failures) {
				if (failure.reason === 'model has no drawable elements') {
					expect(meshIds.has(failure.id)).toBe(false);
				}
			}

			// IE packs several states of a block into one OBJ, so the object names
			// have to survive into the pack for a consumer to filter on.
			expect(meshes.some(model => (model.mesh ?? []).some(group => group.object))).toBe(true);

			// A mod's fluids are as invisible to the model graph as vanilla's, and
			// there are far more of them: Create alone adds chocolate, honey, tea.
			const modFluids = Object.keys(pack.atlas.sprites).filter(id => /_(?:still|flow|flowing)$/.test(id));
			expect(modFluids.length).toBeGreaterThan(20);
			expect(modFluids.some(id => id.startsWith('create:'))).toBe(true);

			// IE's split multiblocks span more than one block position.
			const multiblocks = Object.values(pack.models).filter(model => model.multiblock?.length);
			expect(multiblocks.length).toBeGreaterThan(20);

			// Create states its render layers rather than leaving them to alpha.
			const stated = Object.values(pack.models).filter(model => model.renderType);
			expect(stated.length).toBeGreaterThan(50);
			for (const model of stated) {
				expect(['solid', 'cutout', 'translucent']).toContain(model.renderType);
			}

			// AE2 spins wall-mounted blocks on a third axis vanilla does not have.
			const spun = Object.values(pack.blockStates)
				.flatMap(definition => definition.variants ?? [])
				.flatMap(entry => entry.apply)
				.filter(variant => variant.z);
			expect(spun.length).toBeGreaterThan(10);

			// AE2 builds its cable bus entirely in code, and 823 of them were the
			// biggest hole in a real base. The cable core it does ship stands in.
			const cableBus = pack.blockStates['ae2:cable_bus'].variants ?? [];
			expect(cableBus).toHaveLength(1);
			expect(pack.models[cableBus[0].apply[0].model].elements.length).toBeGreaterThan(0);

			// A block the mod draws in Java, standing on the item model it ships
			// for the inventory: AE2's drive, its crafting storage `formed` states.
			const fromItemModels = pack.result.failures
				.filter(failure => failure.reason.includes('substitutes the block'));
			expect(fromItemModels.length).toBeGreaterThan(10);
			for (const failure of fromItemModels) {
				const definition = pack.blockStates[failure.id];
				const drawn = [...definition.variants ?? [], ...definition.multipart ?? []]
					.flatMap(entry => entry.apply);
				expect(drawn.some(variant => pack.models[variant.model].elements.length > 0)).toBe(true);
			}

			expect(unexpectedFailures(pack, true)).toEqual([]);
		} finally {
			await prepared.close();
		}
	});

	it('handles the loader extensions of a newer NeoForge era', { timeout: 600000 }, async () => {
		// A different loader generation to the Forge 1.20.1 pack above, and the
		// three newest classes: an arbitrary element angle, a loader naming its
		// delegate, and a blockstate a NeoForge definition loader owns.
		const jars = await Promise.all([
			ensureModrinthJar({ slug: 'supplementaries', gameVersion: '1.21.1', loader: 'neoforge' }),
			ensureModrinthJar({ slug: 'framedblocks', gameVersion: '1.21.1', loader: 'neoforge' }),
		]);
		const vanilla = await prepareVersionResources({ version: '1.21.1', jar: vanillaJar('1.21.1') });
		const prepared = await prepareModResources({ jars, vanilla });
		try {
			const pack = await exportPack('mods-neoforge', prepared.resources, ['supplementaries', 'framedblocks']);
			assertSelfContained(pack);

			// FramedBlocks states every one of its blocks through a definition
			// loader; without reading `base_model` only a couple export at all.
			const framed = Object.keys(pack.blockStates).filter(id => id.startsWith('framedblocks:'));
			expect(framed.length).toBeGreaterThan(200);

			// Supplementaries slants its awnings past vanilla's 22.5 steps.
			const awning = pack.models['supplementaries:block/awnings/bottom_slanted'];
			expect(awning.elements.some((element) => {
				const angle = element.rotation?.angle ?? 0;
				return angle !== 0 && angle % 22.5 !== 0;
			})).toBe(true);

			// The faucet's geometry is in the model its loader names.
			expect(pack.models['supplementaries:block/faucet'].elements.length).toBeGreaterThan(4);

			expect(unexpectedFailures(pack, true)).toEqual([]);
		} finally {
			await prepared.close();
		}
	});
});
