/**
 * Biome climate: the half of a real per-biome tint that is not in the assets.
 *
 * Vanilla's table is transcribed, so what is worth testing there is that it says
 * what the game says. A mod's is read out of its jar, so what is worth testing
 * there is every shape a datapack writes one in — the newest vanilla files use
 * `#rrggbb` and every jar built before them writes the same colour as a decimal
 * int — and that a mod stating no climate at all is not guessed at.
 */
import { describe, expect, it } from 'vitest';

import { fixtureModJar } from './fixtures/mods.ts';
import { VANILLA_BIOME_CLIMATES, buildBiomeClimates, parseBiomeClimate } from '../src/blocks/biomes.ts';
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

describe('VANILLA_BIOME_CLIMATES', () => {
	it('carries what the game carries, for the biomes whose colour is recognisable', () => {
		expect(VANILLA_BIOME_CLIMATES['minecraft:plains']).toEqual({ temperature: 0.8, downfall: 0.4 });
		expect(VANILLA_BIOME_CLIMATES['minecraft:swamp']).toMatchObject({ modifier: 'swamp', water: '#617b64' });
		expect(VANILLA_BIOME_CLIMATES['minecraft:badlands']).toMatchObject({ grass: '#90814d', foliage: '#9e814d' });
		expect(VANILLA_BIOME_CLIMATES['minecraft:warm_ocean']).toMatchObject({ water: '#43d5ee' });
		expect(VANILLA_BIOME_CLIMATES['minecraft:dark_forest']).toMatchObject({ modifier: 'dark_forest' });
	});

	it('states a climate for every biome, since that is what addresses a colormap', () => {
		for (const [id, climate] of Object.entries(VANILLA_BIOME_CLIMATES)) {
			expect(id, id).toMatch(/^minecraft:[a-z_]+$/);
			expect(typeof climate.temperature, id).toBe('number');
			expect(typeof climate.downfall, id).toBe('number');
			for (const colour of [climate.water, climate.grass, climate.foliage, climate.dryFoliage]) {
				if (colour !== undefined) {
					expect(colour, id).toMatch(/^#[\da-f]{6}$/);
				}
			}
		}
	});
});

describe('buildBiomeClimates', () => {
	it('gives the minecraft namespace the whole vanilla table', async () => {
		const built = await buildBiomeClimates(new MapResourceManager(), ['minecraft']);
		expect(built.pack['minecraft:plains']).toEqual({ temperature: 0.8, downfall: 0.4 });
		expect(Object.keys(built.pack).length).toBe(Object.keys(VANILLA_BIOME_CLIMATES).length);
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
		const built = await buildBiomeClimates(resources, ['examplemod']);
		expect(built.pack).toEqual({
			'examplemod:crystal_fields': { temperature: 0.5, downfall: 0.5, water: '#112233', grass: '#445566' },
		});
	});

	it('names a biome it could not read rather than dropping it silently', async () => {
		const resources = new MapResourceManager();
		resources.set('biome', 'examplemod:broken', '{ not json');
		resources.set('biome', 'examplemod:climateless', JSON.stringify({ effects: { water_color: 1 } }));
		const built = await buildBiomeClimates(resources, ['examplemod']);
		expect(built.pack).toEqual({});
		expect(built.unreadable.toSorted((left, right) => left.localeCompare(right)))
			.toEqual(['examplemod:broken', 'examplemod:climateless']);
	});

	it('reads a biome out of a jar, which keeps them under data/ rather than assets/', async () => {
		// Why `ResourceKind` has a root at all: a manager that assumed assets/ could not
		// see a datapack biome, and a modded biome is only ever a datapack file
		const jar = new JarResourceManager(fixtureModJar('depcore'));
		try {
			const built = await buildBiomeClimates(jar, ['depcore']);
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
