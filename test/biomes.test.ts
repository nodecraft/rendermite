/**
 * Biome climate: the half of a real per-biome tint that is not in the assets.
 *
 * Vanilla's tables for the versions whose jars carry no biome data are frozen
 * history, so what is worth testing there is that each version gets its own set
 * under its own names. A mod's is read out of its jar, so what is worth testing
 * there is every shape a datapack writes one in — the newest vanilla files use
 * `#rrggbb` and every jar built before them writes the same colour as a decimal
 * int — and that a mod stating no climate at all is not guessed at.
 */
import { describe, expect, it } from 'vitest';

import { fixtureModJar } from './fixtures/mods.ts';
import {
	LEGACY_BIOMES,
	buildBiomeClimates,
	parseBiomeClimate,
	vanillaBiomesFor,
} from '../src/blocks/biomes.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

describe('parseBiomeClimate', () => {
	it('reads the climate and the colours a datapack states', () => {
		expect(parseBiomeClimate({
			temperature: 0.8,
			downfall: 0.9,
			effects: {
				water_color: '#617b64',
				grass_color_modifier: 'swamp',
				foliage_color: '#6a7039',
				dry_foliage_color: '#7b5334',
			},
		})).toEqual({
			temperature: 0.8,
			downfall: 0.9,
			water: '#617b64',
			modifier: 'swamp',
			foliage: '#6a7039',
			dryFoliage: '#7b5334',
		});
	});

	it('takes a colour as an int, which is how a jar built before 1.21.9 writes one', () => {
		// 6388580 is 0x617B64, swamp water: the same 24 bits the newest files spell in hex
		expect(parseBiomeClimate({ temperature: 0.5, downfall: 0.5, effects: { water_color: 6_388_580 } }))
			.toEqual({ temperature: 0.5, downfall: 0.5, water: '#617b64' });
	});

	it('leaves out a water colour that is already the default', () => {
		// Two thirds of the biomes in any pack, and repeating it is most of the file
		expect(parseBiomeClimate({ temperature: 0.5, downfall: 0.5, effects: { water_color: 4_159_204 } }))
			.toEqual({ temperature: 0.5, downfall: 0.5 });
	});

	it('states no climate rather than guessing one', () => {
		// A colormap is addressed by temperature and downfall; without them there is no
		// lookup to make, and inventing one tints a world a colour the game never draws
		expect(parseBiomeClimate({ effects: { water_color: '#112233' } })).toBeNull();
		expect(parseBiomeClimate({ temperature: 0.5 })).toBeNull();
		expect(parseBiomeClimate(null)).toBeNull();
	});

	it('ignores a modifier the game does not have', () => {
		expect(parseBiomeClimate({ temperature: 0.5, downfall: 0.5, effects: { grass_color_modifier: 'mangrove' } }))
			.toEqual({ temperature: 0.5, downfall: 0.5 });
	});
});

describe('vanillaBiomesFor', () => {
	it('gives a pre-1.18 version its own names and the ids its chunks store', () => {
		const pack = vanillaBiomesFor('1.16.5');
		expect(pack['minecraft:mountains']).toEqual({ id: 3, temperature: 0.2, downfall: 0.3 });
		expect(pack['minecraft:windswept_hills']).toBeUndefined();
		// Savanna ran cooler before 1.18 retuned it, so a modern table tints an old world wrong
		expect(pack['minecraft:savanna']).toMatchObject({ temperature: 1.2 });
		expect(vanillaBiomesFor('1.18.2')['minecraft:savanna']).toMatchObject({ temperature: 2 });
	});

	it('holds back the biomes a release had not added yet', () => {
		const old = vanillaBiomesFor('1.13.2');
		expect(old['minecraft:bamboo_jungle']).toBeUndefined();
		expect(old['minecraft:nether']).toMatchObject({ id: 8 });
		expect(old['minecraft:nether_wastes']).toBeUndefined();
		expect(vanillaBiomesFor('1.14.4')['minecraft:bamboo_jungle']).toMatchObject({ id: 168 });
		expect(vanillaBiomesFor('1.16.1')['minecraft:nether_wastes']).toMatchObject({ id: 8 });
		expect(vanillaBiomesFor('1.16.5')['minecraft:lush_caves']).toBeUndefined();
		expect(vanillaBiomesFor('1.17.1')['minecraft:lush_caves']).toMatchObject({ id: 175 });
		expect(vanillaBiomesFor('1.18.2')['minecraft:deep_dark']).toBeUndefined();
		expect(vanillaBiomesFor('1.19.2')['minecraft:deep_dark']).toBeDefined();
	});

	it('gives no ids once chunks store biomes by name', () => {
		expect(Object.values(vanillaBiomesFor('1.18.2')).some(climate => climate.id !== undefined)).toBe(false);
	});

	it('keeps every legacy id distinct, since a chunk decodes against them', () => {
		const ids = LEGACY_BIOMES.map(biome => biome.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe('buildBiomeClimates', () => {
	it('gives the minecraft namespace the version table when the jar has no biome data', async () => {
		const built = await buildBiomeClimates(new MapResourceManager(), ['minecraft'], '1.18.2');
		expect(built.pack).toEqual(vanillaBiomesFor('1.18.2'));
	});

	it('uses only the biomes a jar ships where it ships any, so no other version leaks in', async () => {
		const resources = new MapResourceManager();
		resources.set('biome', 'minecraft:plains', JSON.stringify({ temperature: 0.8, downfall: 0.4 }));
		const built = await buildBiomeClimates(resources, ['minecraft'], '26.3');
		expect(built.pack).toEqual({ 'minecraft:plains': { temperature: 0.8, downfall: 0.4 } });
	});

	it('carries only its own biomes for a mod namespace', async () => {
		// A mod pack is fetched beside the vanilla one, so repeating vanilla's table in
		// each of the hundreds of published mod packs is the same bytes over again
		const resources = new MapResourceManager();
		resources.set('biome', 'examplemod:crystal_fields', JSON.stringify({
			temperature: 0.5,
			downfall: 0.5,
			effects: { water_color: '#112233', grass_color: '#445566' },
		}));
		const built = await buildBiomeClimates(resources, ['examplemod'], '26.3');
		expect(built.pack).toEqual({
			'examplemod:crystal_fields': { temperature: 0.5, downfall: 0.5, water: '#112233', grass: '#445566' },
		});
	});

	it('names a biome it could not read rather than dropping it silently', async () => {
		const resources = new MapResourceManager();
		resources.set('biome', 'examplemod:broken', '{ not json');
		resources.set('biome', 'examplemod:climateless', JSON.stringify({ effects: { water_color: 1 } }));
		const built = await buildBiomeClimates(resources, ['examplemod'], '26.3');
		expect(built.pack).toEqual({});
		expect(built.unreadable.toSorted((left, right) => left.localeCompare(right)))
			.toEqual(['examplemod:broken', 'examplemod:climateless']);
	});

	it('reads a biome out of a jar, which keeps them under data/ rather than assets/', async () => {
		// Why `ResourceKind` has a root at all: a manager that assumed assets/ could not
		// see a datapack biome, and a modded biome is only ever a datapack file
		const jar = new JarResourceManager(fixtureModJar('depcore'));
		try {
			const built = await buildBiomeClimates(jar, ['depcore'], '26.3');
			expect(built.pack['depcore:machine_wastes']).toEqual({
				temperature: 0.4,
				downfall: 0.2,
				water: '#3a4a5a',
				grass: '#7d8a5c',
				modifier: 'dark_forest',
			});
		} finally {
			await jar.close();
		}
	});
});
