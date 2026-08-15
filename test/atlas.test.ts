import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { loadAtlasResolver } from '../src/atlas/registry.ts';
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
