/**
 * Biome climate for the exported pack: what a renderer needs to colour grass,
 * foliage and water the way the game does, per biome rather than per version.
 *
 * `tints.json` says *which* colormap a block reads and ships the images; this
 * says where in one to read. A consumer with both can draw a swamp grey-green
 * and a badlands tan instead of tinting every biome as a plains.
 *
 * Vanilla's own climates are the table below rather than a read of the assets,
 * because no client jar contains them — biomes are code in the game and data
 * only in the server's generated reports. The values are transcribed from the
 * vanilla data (via misode/mcmeta) and are a superset across versions: a biome
 * a version does not have simply never appears in one of its worlds, and the
 * climates of the ones it does have do not move between versions.
 *
 * Mods are read rather than transcribed. A modded biome is a datapack file in
 * the jar (`data/<ns>/worldgen/biome/<name>.json`), which is the same shape the
 * server reports write, so `harvestBiomeClimates` parses whatever a jar ships.
 */

import type { ResourceManager } from '../resources/manager.ts';

/** Where a biome's colours come from. Colours are `#rrggbb`, as everywhere else in the pack. */
export interface BiomeClimate {
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

/** Every vanilla biome's climate, by id. Ordered so a regenerated table diffs cleanly. */
export const VANILLA_BIOME_CLIMATES: BiomeClimatePack = {
	'minecraft:badlands': { temperature: 2, downfall: 0, grass: '#90814d', foliage: '#9e814d' },
	'minecraft:bamboo_jungle': { temperature: 0.95, downfall: 0.9 },
	'minecraft:basalt_deltas': { temperature: 2, downfall: 0 },
	'minecraft:beach': { temperature: 0.8, downfall: 0.4 },
	'minecraft:birch_forest': { temperature: 0.6, downfall: 0.6 },
	'minecraft:cherry_grove': { temperature: 0.5, downfall: 0.8, water: '#5db7ef', grass: '#b6db61', foliage: '#b6db61' },
	'minecraft:cold_ocean': { temperature: 0.5, downfall: 0.5, water: '#3d57d6' },
	'minecraft:crimson_forest': { temperature: 2, downfall: 0 },
	'minecraft:dappled_forest': { temperature: 0.6, downfall: 0.6, water: '#375154', grass: '#df6827', foliage: '#e68e30', dryFoliage: '#8c3a04' },
	'minecraft:dark_forest': { temperature: 0.7, downfall: 0.8, modifier: 'dark_forest', dryFoliage: '#7b5334' },
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
	'minecraft:mangrove_swamp': { temperature: 0.8, downfall: 0.9, water: '#3a7a6a', modifier: 'swamp', foliage: '#8db127', dryFoliage: '#7b5334' },
	'minecraft:meadow': { temperature: 0.5, downfall: 0.8, water: '#0e4ecf' },
	'minecraft:mushroom_fields': { temperature: 0.9, downfall: 1 },
	'minecraft:nether_wastes': { temperature: 2, downfall: 0 },
	'minecraft:ocean': { temperature: 0.5, downfall: 0.5 },
	'minecraft:old_growth_birch_forest': { temperature: 0.6, downfall: 0.6 },
	'minecraft:old_growth_pine_taiga': { temperature: 0.3, downfall: 0.8 },
	'minecraft:old_growth_spruce_taiga': { temperature: 0.25, downfall: 0.8 },
	'minecraft:pale_garden': { temperature: 0.7, downfall: 0.8, water: '#76889d', grass: '#778272', foliage: '#878d76', dryFoliage: '#a0a69c' },
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
	'minecraft:sulfur_caves': { temperature: 0.8, downfall: 0.4, water: '#34bf89', grass: '#aba64f' },
	'minecraft:sunflower_plains': { temperature: 0.8, downfall: 0.4 },
	'minecraft:swamp': { temperature: 0.8, downfall: 0.9, water: '#617b64', modifier: 'swamp', foliage: '#6a7039', dryFoliage: '#7b5334' },
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
 * plus vanilla's own table when `minecraft` is one of them.
 *
 * A mod pack carries only its own biomes. The vanilla pack is always fetched
 * beside it, so repeating vanilla's would be the same bytes in every one of the
 * hundreds of mod packs published.
 */
export async function buildBiomeClimates(
	resources: ResourceManager,
	namespaces: readonly string[],
): Promise<{ pack: BiomeClimatePack; unreadable: string[]; }> {
	const pack: BiomeClimatePack = {};
	const unreadable: string[] = [];
	for (const namespace of namespaces) {
		if (namespace === 'minecraft') {
			Object.assign(pack, VANILLA_BIOME_CLIMATES);
		}
		for (const locator of await resources.listResources('biome', namespace)) {
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
			// A datapack's own file wins over the transcribed table: it is the version's
			// answer rather than a snapshot of one.
			pack[locator.toString()] = climate;
		}
	}
	return { pack, unreadable };
}
