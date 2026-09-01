import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { loadAtlasResolver } from '../src/atlas/registry.ts';
import { collectArmourTrims } from '../src/blocks/entity-models.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { TextureLoader } from '../src/textures/loader.ts';

async function pixel(red: number, green: number, blue: number, alpha = 255): Promise<Buffer> {
	return sharp({ create: { width: 1, height: 1, channels: 4, background: { r: red, g: green, b: blue, alpha: alpha / 255 } } })
		.png()
		.toBuffer();
}

describe('inferred flat item trims', () => {
	it('palette-swaps a missing conventional trim sprite when all inputs exist', async () => {
		const resources = new MapResourceManager()
			.set('texture', 'example:trims/items/gloves_trim', await pixel(128, 128, 128))
			.set('texture', 'minecraft:trims/color_palettes/trim_palette', await pixel(128, 128, 128))
			.set('texture', 'minecraft:trims/color_palettes/amethyst', await pixel(180, 60, 220));
		const textures = new TextureLoader(resources);
		textures.setAtlasResolver(await loadAtlasResolver(resources, locator => textures.load(locator)));

		const resolved = await textures.load(ResourceLocator.parse('example:trims/items/gloves_trim_amethyst'));
		expect(resolved).not.toBeNull();
		expect([...resolved!.data]).toEqual([180, 60, 220, 255]);
	});

	it('resolves 26.3+ palette ids under the textures/palettes/ root', async () => {
		// 26.3 moved trim palettes to textures/palettes/ and the atlas references
		// them by bare id (palette_key "minecraft:trim_base", permutation
		// "minecraft:trim/quartz") — neither is a direct texture path.
		const resources = new MapResourceManager()
			.set('atlas', 'minecraft:items', JSON.stringify({
				sources: [{
					type: 'minecraft:paletted_permutations',
					textures: ['minecraft:trims/items/boots_trim'],
					palette_key: 'minecraft:trim_base',
					permutations: { quartz: 'minecraft:trim/quartz' },
				}],
			}))
			.set('texture', 'minecraft:trims/items/boots_trim', await pixel(128, 128, 128))
			.set('texture', 'minecraft:palettes/trim_base', await pixel(128, 128, 128))
			.set('texture', 'minecraft:palettes/trim/quartz', await pixel(230, 224, 210));
		const textures = new TextureLoader(resources);
		textures.setAtlasResolver(await loadAtlasResolver(resources, locator => textures.load(locator)));

		const resolved = await textures.load(ResourceLocator.parse('minecraft:trims/items/boots_trim_quartz'));
		expect(resolved).not.toBeNull();
		expect([...resolved!.data]).toEqual([230, 224, 210, 255]);
	});

	it('does not invent a sprite when its requested palette is absent', async () => {
		const resources = new MapResourceManager()
			.set('texture', 'example:trims/items/gloves_trim', await pixel(128, 128, 128))
			.set('texture', 'minecraft:trims/color_palettes/trim_palette', await pixel(128, 128, 128));
		const textures = new TextureLoader(resources);
		textures.setAtlasResolver(await loadAtlasResolver(resources, locator => textures.load(locator)));

		expect(await textures.load(ResourceLocator.parse('example:trims/items/gloves_trim_unknown'))).toBeNull();
	});
});

describe('trim materials from mods', () => {
	it('finds a namespaced material\'s palette under its own namespace', async () => {
		// A mod trim material's asset_name is `<namespace>-<path>`, but its palette
		// stays in the mod: blue_skies-moonstone ↔ blue_skies:.../moonstone.
		const resources = new MapResourceManager()
			.set('texture', 'minecraft:trims/items/boots_trim', await pixel(128, 128, 128))
			.set('texture', 'minecraft:trims/color_palettes/trim_palette', await pixel(128, 128, 128))
			.set('texture', 'blue_skies:trims/color_palettes/moonstone', await pixel(217, 238, 247));
		const textures = new TextureLoader(resources);
		textures.setAtlasResolver(await loadAtlasResolver(resources, locator => textures.load(locator)));

		const resolved = await textures.load(ResourceLocator.parse('minecraft:trims/items/boots_trim_blue_skies-moonstone'));
		expect(resolved).not.toBeNull();
		expect([...resolved!.data]).toEqual([217, 238, 247, 255]);
	});

	it('still refuses when the mod ships no palette for the material', async () => {
		const resources = new MapResourceManager()
			.set('texture', 'minecraft:trims/items/boots_trim', await pixel(128, 128, 128))
			.set('texture', 'minecraft:trims/color_palettes/trim_palette', await pixel(128, 128, 128));
		const textures = new TextureLoader(resources);
		textures.setAtlasResolver(await loadAtlasResolver(resources, locator => textures.load(locator)));
		expect(await textures.load(ResourceLocator.parse('minecraft:trims/items/boots_trim_blue_skies-moonstone'))).toBeNull();
	});
});

describe('worn armour trims', () => {
	it('discovers pattern sheets, namespaced materials, and darker fallbacks from the atlas', async () => {
		const resources = new MapResourceManager().set('atlas', 'minecraft:armor_trims', JSON.stringify({
			sources: [{
				type: 'minecraft:paletted_permutations',
				textures: [
					'minecraft:trims/entity/humanoid/coast',
					'minecraft:trims/entity/humanoid_leggings/coast',
				],
				palette_key: 'minecraft:trims/color_palettes/trim_palette',
				permutations: {
					'copper': 'minecraft:trims/color_palettes/copper',
					'copper_darker': 'minecraft:trims/color_palettes/copper_darker',
					'blue_skies-moonstone': 'blue_skies:trims/color_palettes/moonstone',
				},
			}],
		}));
		const sprites = new Set<string>();

		const trims = await collectArmourTrims(resources, sprites);

		expect(trims.darker).toEqual({ 'minecraft:copper': 'minecraft:copper_darker' });
		expect(trims.patterns['minecraft:coast']['minecraft:copper']).toEqual({
			outer: 'minecraft:trims/entity/humanoid/coast_copper',
			inner: 'minecraft:trims/entity/humanoid_leggings/coast_copper',
		});
		expect(trims.patterns['minecraft:coast']['blue_skies:moonstone']).toEqual({
			outer: 'minecraft:trims/entity/humanoid/coast_blue_skies-moonstone',
			inner: 'minecraft:trims/entity/humanoid_leggings/coast_blue_skies-moonstone',
		});
		expect(sprites).toContain('minecraft:trims/entity/humanoid/coast_copper_darker');
		expect(sprites).toHaveLength(6);
	});

	it('returns an empty section for versions from before armour trims', async () => {
		const sprites = new Set<string>();

		await expect(collectArmourTrims(new MapResourceManager(), sprites)).resolves.toEqual({
			patterns: {},
			darker: {},
		});
		expect(sprites).toHaveLength(0);
	});

	it('recognises the shared armour folder and leggings suffix used before 1.21.2', async () => {
		const resources = new MapResourceManager().set('atlas', 'minecraft:armor_trims', JSON.stringify({
			sources: [{
				type: 'paletted_permutations',
				textures: ['trims/models/armor/coast', 'trims/models/armor/coast_leggings'],
				palette_key: 'trims/color_palettes/trim_palette',
				permutations: { gold: 'trims/color_palettes/gold' },
			}],
		}));

		const trims = await collectArmourTrims(resources, new Set());

		expect(trims.patterns['minecraft:coast']['minecraft:gold']).toEqual({
			outer: 'minecraft:trims/models/armor/coast_gold',
			inner: 'minecraft:trims/models/armor/coast_leggings_gold',
		});
	});
});
