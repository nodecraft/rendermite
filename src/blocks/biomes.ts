/**
 * Biome climate for the exported pack: what a renderer needs to colour grass,
 * foliage and water the way the game does, per biome rather than per version.
 *
 * `tints.json` says *which* colormap a block reads and ships the images; this
 * says where in one to read. A consumer with both can draw a swamp grey-green
 * and a badlands tan instead of tinting every biome as a plains.
 *
 * Every pack carries exactly the biomes its version has, under the names that
 * version uses, so the file doubles as the version's biome list:
 *
 * - From 1.19.3 a client jar ships vanilla's own biome definitions under
 *   `data/minecraft/worldgen/biome/`, and only those are used.
 * - 1.18 to 1.19.2 kept biomes in code. `PRE_JAR_BIOMES` is the 1.19.2 data
 *   generator's `worldgen/biome` report, which 1.18 matches less the two 1.19 biomes.
 * - 1.13 to 1.17 stored biomes in chunks as numeric ids, under names 1.18 retired
 *   (`mountains`, `giant_tree_taiga`). `LEGACY_BIOMES` is the 1.17.1 generator's
 *   `biomes` report with each biome's id, and a pack from that era writes the id
 *   too, so a consumer decodes a chunk against the version's own registry.
 *
 * Both tables are frozen history: those versions are closed, and their jars carry
 * nothing to read instead.
 *
 * Mods are read rather than transcribed. A modded biome is a datapack file in
 * the jar (`data/<ns>/worldgen/biome/<name>.json`), which is the same shape the
 * server reports write, so `harvestBiomeClimates` parses whatever a jar ships.
 */

import { compareVersions } from '../versions/prepare.ts';

import type { ResourceManager } from '../resources/manager.ts';

/** Where a biome's colours come from. Colours are `#rrggbb`, as everywhere else in the pack. */
export interface BiomeClimate {
	/**
	 * The numeric id a chunk stores this biome as, before 1.18 replaced ids with names. Absent from a
	 * 1.18+ pack and from a mod's biomes, whose ids were assigned per world.
	 */
	id?: number;
	/** As the biome declares it, unclamped: the peaks run to -0.7 and the deserts to 2. */
	temperature: number;
	downfall: number;
	/** `effects.water_color`, when it is not the default. */
	water?: string;
	/** `effects.grass_color_modifier`, applied after the colormap lookup. */
	modifier?: 'dark_forest' | 'swamp';
	/** `effects.grass_color`, which replaces the colormap lookup outright. */
	grass?: string;
	foliage?: string;
	dryFoliage?: string;
}

/** `biomes.json`: biome id → climate. */
export type BiomeClimatePack = Record<string, BiomeClimate>;

/** `effects.water_color` where a biome does not override it, which is most of them. */
export const DEFAULT_WATER_COLOR = '#3f76e4';

export interface LegacyBiome {
	id: number;
	name: string;
	/** The release that added it; absent for the biomes 1.13 already had. */
	since?: '1.14' | '1.16' | '1.17';
	climate: Omit<BiomeClimate, 'id'>;
}

/** 1.13–1.17, from the 1.17.1 data generator's `reports/biomes`, in id order. */
export const LEGACY_BIOMES: readonly LegacyBiome[] = [
	{ id: 0, name: 'minecraft:ocean', climate: { temperature: 0.5, downfall: 0.5 } },
	{ id: 1, name: 'minecraft:plains', climate: { temperature: 0.8, downfall: 0.4 } },
	{ id: 2, name: 'minecraft:desert', climate: { temperature: 2, downfall: 0 } },
	{ id: 3, name: 'minecraft:mountains', climate: { temperature: 0.2, downfall: 0.3 } },
	{ id: 4, name: 'minecraft:forest', climate: { temperature: 0.7, downfall: 0.8 } },
	{ id: 5, name: 'minecraft:taiga', climate: { temperature: 0.25, downfall: 0.8 } },
	{ id: 6, name: 'minecraft:swamp', climate: { temperature: 0.8, downfall: 0.9, water: '#617b64', modifier: 'swamp', foliage: '#6a7039' } },
	{ id: 7, name: 'minecraft:river', climate: { temperature: 0.5, downfall: 0.5 } },
	{ id: 8, name: 'minecraft:nether_wastes', climate: { temperature: 2, downfall: 0 } },
	{ id: 9, name: 'minecraft:the_end', climate: { temperature: 0.5, downfall: 0.5 } },
	{ id: 10, name: 'minecraft:frozen_ocean', climate: { temperature: 0, downfall: 0.5, water: '#3938c9' } },
	{ id: 11, name: 'minecraft:frozen_river', climate: { temperature: 0, downfall: 0.5, water: '#3938c9' } },
	{ id: 12, name: 'minecraft:snowy_tundra', climate: { temperature: 0, downfall: 0.5 } },
	{ id: 13, name: 'minecraft:snowy_mountains', climate: { temperature: 0, downfall: 0.5 } },
	{ id: 14, name: 'minecraft:mushroom_fields', climate: { temperature: 0.9, downfall: 1 } },
	{ id: 15, name: 'minecraft:mushroom_field_shore', climate: { temperature: 0.9, downfall: 1 } },
	{ id: 16, name: 'minecraft:beach', climate: { temperature: 0.8, downfall: 0.4 } },
	{ id: 17, name: 'minecraft:desert_hills', climate: { temperature: 2, downfall: 0 } },
	{ id: 18, name: 'minecraft:wooded_hills', climate: { temperature: 0.7, downfall: 0.8 } },
	{ id: 19, name: 'minecraft:taiga_hills', climate: { temperature: 0.25, downfall: 0.8 } },
	{ id: 20, name: 'minecraft:mountain_edge', climate: { temperature: 0.2, downfall: 0.3 } },
	{ id: 21, name: 'minecraft:jungle', climate: { temperature: 0.95, downfall: 0.9 } },
	{ id: 22, name: 'minecraft:jungle_hills', climate: { temperature: 0.95, downfall: 0.9 } },
	{ id: 23, name: 'minecraft:jungle_edge', climate: { temperature: 0.95, downfall: 0.8 } },
	{ id: 24, name: 'minecraft:deep_ocean', climate: { temperature: 0.5, downfall: 0.5 } },
	{ id: 25, name: 'minecraft:stone_shore', climate: { temperature: 0.2, downfall: 0.3 } },
	{ id: 26, name: 'minecraft:snowy_beach', climate: { temperature: 0.05, downfall: 0.3, water: '#3d57d6' } },
	{ id: 27, name: 'minecraft:birch_forest', climate: { temperature: 0.6, downfall: 0.6 } },
	{ id: 28, name: 'minecraft:birch_forest_hills', climate: { temperature: 0.6, downfall: 0.6 } },
	{ id: 29, name: 'minecraft:dark_forest', climate: { temperature: 0.7, downfall: 0.8, modifier: 'dark_forest' } },
	{ id: 30, name: 'minecraft:snowy_taiga', climate: { temperature: -0.5, downfall: 0.4, water: '#3d57d6' } },
	{ id: 31, name: 'minecraft:snowy_taiga_hills', climate: { temperature: -0.5, downfall: 0.4, water: '#3d57d6' } },
	{ id: 32, name: 'minecraft:giant_tree_taiga', climate: { temperature: 0.3, downfall: 0.8 } },
	{ id: 33, name: 'minecraft:giant_tree_taiga_hills', climate: { temperature: 0.3, downfall: 0.8 } },
	{ id: 34, name: 'minecraft:wooded_mountains', climate: { temperature: 0.2, downfall: 0.3 } },
	{ id: 35, name: 'minecraft:savanna', climate: { temperature: 1.2, downfall: 0 } },
	{ id: 36, name: 'minecraft:savanna_plateau', climate: { temperature: 1, downfall: 0 } },
	{ id: 37, name: 'minecraft:badlands', climate: { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' } },
	{ id: 38, name: 'minecraft:wooded_badlands_plateau', climate: { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' } },
	{ id: 39, name: 'minecraft:badlands_plateau', climate: { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' } },
	{ id: 40, name: 'minecraft:small_end_islands', climate: { temperature: 0.5, downfall: 0.5 } },
	{ id: 41, name: 'minecraft:end_midlands', climate: { temperature: 0.5, downfall: 0.5 } },
	{ id: 42, name: 'minecraft:end_highlands', climate: { temperature: 0.5, downfall: 0.5 } },
	{ id: 43, name: 'minecraft:end_barrens', climate: { temperature: 0.5, downfall: 0.5 } },
	{ id: 44, name: 'minecraft:warm_ocean', climate: { temperature: 0.5, downfall: 0.5, water: '#43d5ee' } },
	{ id: 45, name: 'minecraft:lukewarm_ocean', climate: { temperature: 0.5, downfall: 0.5, water: '#45adf2' } },
	{ id: 46, name: 'minecraft:cold_ocean', climate: { temperature: 0.5, downfall: 0.5, water: '#3d57d6' } },
	{ id: 47, name: 'minecraft:deep_warm_ocean', climate: { temperature: 0.5, downfall: 0.5, water: '#43d5ee' } },
	{ id: 48, name: 'minecraft:deep_lukewarm_ocean', climate: { temperature: 0.5, downfall: 0.5, water: '#45adf2' } },
	{ id: 49, name: 'minecraft:deep_cold_ocean', climate: { temperature: 0.5, downfall: 0.5, water: '#3d57d6' } },
	{ id: 50, name: 'minecraft:deep_frozen_ocean', climate: { temperature: 0.5, downfall: 0.5, water: '#3938c9' } },
	{ id: 127, name: 'minecraft:the_void', climate: { temperature: 0.5, downfall: 0.5 } },
	{ id: 129, name: 'minecraft:sunflower_plains', climate: { temperature: 0.8, downfall: 0.4 } },
	{ id: 130, name: 'minecraft:desert_lakes', climate: { temperature: 2, downfall: 0 } },
	{ id: 131, name: 'minecraft:gravelly_mountains', climate: { temperature: 0.2, downfall: 0.3 } },
	{ id: 132, name: 'minecraft:flower_forest', climate: { temperature: 0.7, downfall: 0.8 } },
	{ id: 133, name: 'minecraft:taiga_mountains', climate: { temperature: 0.25, downfall: 0.8 } },
	{ id: 134, name: 'minecraft:swamp_hills', climate: { temperature: 0.8, downfall: 0.9, water: '#617b64', modifier: 'swamp', foliage: '#6a7039' } },
	{ id: 140, name: 'minecraft:ice_spikes', climate: { temperature: 0, downfall: 0.5 } },
	{ id: 149, name: 'minecraft:modified_jungle', climate: { temperature: 0.95, downfall: 0.9 } },
	{ id: 151, name: 'minecraft:modified_jungle_edge', climate: { temperature: 0.95, downfall: 0.8 } },
	{ id: 155, name: 'minecraft:tall_birch_forest', climate: { temperature: 0.6, downfall: 0.6 } },
	{ id: 156, name: 'minecraft:tall_birch_hills', climate: { temperature: 0.6, downfall: 0.6 } },
	{ id: 157, name: 'minecraft:dark_forest_hills', climate: { temperature: 0.7, downfall: 0.8, modifier: 'dark_forest' } },
	{ id: 158, name: 'minecraft:snowy_taiga_mountains', climate: { temperature: -0.5, downfall: 0.4, water: '#3d57d6' } },
	{ id: 160, name: 'minecraft:giant_spruce_taiga', climate: { temperature: 0.25, downfall: 0.8 } },
	{ id: 161, name: 'minecraft:giant_spruce_taiga_hills', climate: { temperature: 0.25, downfall: 0.8 } },
	{ id: 162, name: 'minecraft:modified_gravelly_mountains', climate: { temperature: 0.2, downfall: 0.3 } },
	{ id: 163, name: 'minecraft:shattered_savanna', climate: { temperature: 1.1, downfall: 0 } },
	{ id: 164, name: 'minecraft:shattered_savanna_plateau', climate: { temperature: 1, downfall: 0 } },
	{ id: 165, name: 'minecraft:eroded_badlands', climate: { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' } },
	{ id: 166, name: 'minecraft:modified_wooded_badlands_plateau', climate: { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' } },
	{ id: 167, name: 'minecraft:modified_badlands_plateau', climate: { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' } },
	{ id: 168, name: 'minecraft:bamboo_jungle', since: '1.14', climate: { temperature: 0.95, downfall: 0.9 } },
	{ id: 169, name: 'minecraft:bamboo_jungle_hills', since: '1.14', climate: { temperature: 0.95, downfall: 0.9 } },
	{ id: 170, name: 'minecraft:soul_sand_valley', since: '1.16', climate: { temperature: 2, downfall: 0 } },
	{ id: 171, name: 'minecraft:crimson_forest', since: '1.16', climate: { temperature: 2, downfall: 0 } },
	{ id: 172, name: 'minecraft:warped_forest', since: '1.16', climate: { temperature: 2, downfall: 0 } },
	{ id: 173, name: 'minecraft:basalt_deltas', since: '1.16', climate: { temperature: 2, downfall: 0 } },
	{ id: 174, name: 'minecraft:dripstone_caves', since: '1.17', climate: { temperature: 0.8, downfall: 0.4 } },
	{ id: 175, name: 'minecraft:lush_caves', since: '1.17', climate: { temperature: 0.5, downfall: 0.5 } },
];

/** 1.16 renamed the Nether's only biome when it gained four more; before that id 8 was `nether`. */
const LEGACY_NETHER = 'minecraft:nether';

/** 1.18–1.19.2, from the 1.19.2 data generator's `worldgen/biome` report. Ordered so a regenerated table diffs cleanly. */
export const PRE_JAR_BIOMES: BiomeClimatePack = {
	'minecraft:badlands': { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' },
	'minecraft:bamboo_jungle': { temperature: 0.95, downfall: 0.9 },
	'minecraft:basalt_deltas': { temperature: 2, downfall: 0 },
	'minecraft:beach': { temperature: 0.8, downfall: 0.4 },
	'minecraft:birch_forest': { temperature: 0.6, downfall: 0.6 },
	'minecraft:cold_ocean': { temperature: 0.5, downfall: 0.5, water: '#3d57d6' },
	'minecraft:crimson_forest': { temperature: 2, downfall: 0 },
	'minecraft:dark_forest': { temperature: 0.7, downfall: 0.8, modifier: 'dark_forest' },
	'minecraft:deep_cold_ocean': { temperature: 0.5, downfall: 0.5, water: '#3d57d6' },
	'minecraft:deep_dark': { temperature: 0.8, downfall: 0.4 },
	'minecraft:deep_frozen_ocean': { temperature: 0.5, downfall: 0.5, water: '#3938c9' },
	'minecraft:deep_lukewarm_ocean': { temperature: 0.5, downfall: 0.5, water: '#45adf2' },
	'minecraft:deep_ocean': { temperature: 0.5, downfall: 0.5 },
	'minecraft:desert': { temperature: 2, downfall: 0 },
	'minecraft:dripstone_caves': { temperature: 0.8, downfall: 0.4 },
	'minecraft:end_barrens': { temperature: 0.5, downfall: 0.5 },
	'minecraft:end_highlands': { temperature: 0.5, downfall: 0.5 },
	'minecraft:end_midlands': { temperature: 0.5, downfall: 0.5 },
	'minecraft:eroded_badlands': { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' },
	'minecraft:flower_forest': { temperature: 0.7, downfall: 0.8 },
	'minecraft:forest': { temperature: 0.7, downfall: 0.8 },
	'minecraft:frozen_ocean': { temperature: 0, downfall: 0.5, water: '#3938c9' },
	'minecraft:frozen_peaks': { temperature: -0.7, downfall: 0.9 },
	'minecraft:frozen_river': { temperature: 0, downfall: 0.5, water: '#3938c9' },
	'minecraft:grove': { temperature: -0.2, downfall: 0.8 },
	'minecraft:ice_spikes': { temperature: 0, downfall: 0.5 },
	'minecraft:jagged_peaks': { temperature: -0.7, downfall: 0.9 },
	'minecraft:jungle': { temperature: 0.95, downfall: 0.9 },
	'minecraft:lukewarm_ocean': { temperature: 0.5, downfall: 0.5, water: '#45adf2' },
	'minecraft:lush_caves': { temperature: 0.5, downfall: 0.5 },
	'minecraft:mangrove_swamp': { temperature: 0.8, downfall: 0.9, water: '#3a7a6a', modifier: 'swamp', foliage: '#8db127' },
	'minecraft:meadow': { temperature: 0.5, downfall: 0.8, water: '#0e4ecf' },
	'minecraft:mushroom_fields': { temperature: 0.9, downfall: 1 },
	'minecraft:nether_wastes': { temperature: 2, downfall: 0 },
	'minecraft:ocean': { temperature: 0.5, downfall: 0.5 },
	'minecraft:old_growth_birch_forest': { temperature: 0.6, downfall: 0.6 },
	'minecraft:old_growth_pine_taiga': { temperature: 0.3, downfall: 0.8 },
	'minecraft:old_growth_spruce_taiga': { temperature: 0.25, downfall: 0.8 },
	'minecraft:plains': { temperature: 0.8, downfall: 0.4 },
	'minecraft:river': { temperature: 0.5, downfall: 0.5 },
	'minecraft:savanna': { temperature: 2, downfall: 0 },
	'minecraft:savanna_plateau': { temperature: 2, downfall: 0 },
	'minecraft:small_end_islands': { temperature: 0.5, downfall: 0.5 },
	'minecraft:snowy_beach': { temperature: 0.05, downfall: 0.3, water: '#3d57d6' },
	'minecraft:snowy_plains': { temperature: 0, downfall: 0.5 },
	'minecraft:snowy_slopes': { temperature: -0.3, downfall: 0.9 },
	'minecraft:snowy_taiga': { temperature: -0.5, downfall: 0.4, water: '#3d57d6' },
	'minecraft:soul_sand_valley': { temperature: 2, downfall: 0 },
	'minecraft:sparse_jungle': { temperature: 0.95, downfall: 0.8 },
	'minecraft:stony_peaks': { temperature: 1, downfall: 0.3 },
	'minecraft:stony_shore': { temperature: 0.2, downfall: 0.3 },
	'minecraft:sunflower_plains': { temperature: 0.8, downfall: 0.4 },
	'minecraft:swamp': { temperature: 0.8, downfall: 0.9, water: '#617b64', modifier: 'swamp', foliage: '#6a7039' },
	'minecraft:taiga': { temperature: 0.25, downfall: 0.8 },
	'minecraft:the_end': { temperature: 0.5, downfall: 0.5 },
	'minecraft:the_void': { temperature: 0.5, downfall: 0.5 },
	'minecraft:warm_ocean': { temperature: 0.5, downfall: 0.5, water: '#43d5ee' },
	'minecraft:warped_forest': { temperature: 2, downfall: 0 },
	'minecraft:windswept_forest': { temperature: 0.2, downfall: 0.3 },
	'minecraft:windswept_gravelly_hills': { temperature: 0.2, downfall: 0.3 },
	'minecraft:windswept_hills': { temperature: 0.2, downfall: 0.3 },
	'minecraft:windswept_savanna': { temperature: 2, downfall: 0 },
	'minecraft:wooded_badlands': { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' },
};

/** @deprecated One version's table stood in for all of them; use `vanillaBiomesFor(version)`. */
export const VANILLA_BIOME_CLIMATES: BiomeClimatePack = PRE_JAR_BIOMES;

/** The two biomes 1.19 added to `PRE_JAR_BIOMES`, which a 1.18 world cannot contain. */
const SINCE_1_19 = new Set(['minecraft:deep_dark', 'minecraft:mangrove_swamp']);

/**
 * Vanilla's biomes as a version without biome data in its jar has them: the version's own set,
 * under its own names. A version that is not a release number (an `--assets` run) gets the newest.
 */
export function vanillaBiomesFor(version: string): BiomeClimatePack {
	const numbered = /^\d+\.\d+/.test(version);
	if (numbered && compareVersions(version, '1.18') < 0) {
		const pack: BiomeClimatePack = {};
		for (const biome of LEGACY_BIOMES) {
			if (biome.since !== undefined && compareVersions(version, biome.since) < 0) {
				continue;
			}
			const name = biome.id === 8 && compareVersions(version, '1.16') < 0 ? LEGACY_NETHER : biome.name;
			pack[name] = { id: biome.id, ...biome.climate };
		}
		return pack;
	}
	if (numbered && compareVersions(version, '1.19') < 0) {
		return Object.fromEntries(Object.entries(PRE_JAR_BIOMES).filter(([id]) => !SINCE_1_19.has(id)));
	}
	return { ...PRE_JAR_BIOMES };
}
/** Vanilla writes `grass_color_modifier` as one of two names; anything else is a mod's typo. */
const MODIFIERS = new Set(['dark_forest', 'swamp']);

/**
 * A colour as biome data spells it. Vanilla's own files use `#rrggbb` now, mod
 * jars built against older versions write the same value as a decimal int, and
 * both mean the same 24 bits.
 */
function biomeColor(value: unknown): string | undefined {
	if (typeof value === 'string') {
		const hex = /^#?([\da-f]{6})$/i.exec(value.trim());
		return hex ? `#${hex[1].toLowerCase()}` : undefined;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return `#${(value & 0xFF_FF_FF).toString(16).padStart(6, '0')}`;
	}
	return undefined;
}

/** One biome definition as a datapack states it, or `null` when it states no climate. */
export function parseBiomeClimate(json: unknown): BiomeClimate | null {
	const biome = json as { temperature?: unknown; downfall?: unknown; effects?: Record<string, unknown>; } | null;
	if (typeof biome?.temperature !== 'number' || typeof biome.downfall !== 'number') {
		// A biome with no climate cannot address a colormap, and guessing one would
		// tint a mod's world with a colour the game never draws.
		return null;
	}
	const effects = biome.effects ?? {};
	const modifier = typeof effects.grass_color_modifier === 'string' && MODIFIERS.has(effects.grass_color_modifier)
		? effects.grass_color_modifier as BiomeClimate['modifier']
		: undefined;
	const water = biomeColor(effects.water_color);
	const grass = biomeColor(effects.grass_color);
	const foliage = biomeColor(effects.foliage_color);
	const dryFoliage = biomeColor(effects.dry_foliage_color);
	return {
		temperature: biome.temperature,
		downfall: biome.downfall,
		// The default is what a consumer falls back to anyway, so writing it would be
		// two thirds of the file saying the same thing
		...(water !== undefined && water !== DEFAULT_WATER_COLOR && { water }),
		...(modifier && { modifier }),
		...(grass !== undefined && { grass }),
		...(foliage !== undefined && { foliage }),
		...(dryFoliage !== undefined && { dryFoliage }),
	};
}

/**
 * Climates for the namespaces a pack exports: whatever their datapacks declare,
 * or for `minecraft` in a jar that declares none, the version's table.
 *
 * A mod pack carries only its own biomes. The vanilla pack is always fetched
 * beside it, so repeating vanilla's would be the same bytes in every one of the
 * hundreds of mod packs published.
 */
export async function buildBiomeClimates(
	resources: ResourceManager,
	namespaces: readonly string[],
	// Optional for callers from before it existed; anything not a release number gets the newest table
	version = 'latest',
): Promise<{ pack: BiomeClimatePack; unreadable: string[]; }> {
	const pack: BiomeClimatePack = {};
	const unreadable: string[] = [];
	for (const namespace of namespaces) {
		const locators = await resources.listResources('biome', namespace);
		if (namespace === 'minecraft' && locators.length === 0) {
			Object.assign(pack, vanillaBiomesFor(version));
		}
		for (const locator of locators) {
			const raw = await resources.getResource('biome', locator);
			if (raw === null) {
				continue;
			}
			let climate: BiomeClimate | null;
			try {
				climate = parseBiomeClimate(JSON.parse(raw.toString('utf8')));
			} catch {
				climate = null;
			}
			if (climate === null) {
				unreadable.push(locator.toString());
				continue;
			}
			pack[locator.toString()] = climate;
		}
	}
	return { pack, unreadable };
}
