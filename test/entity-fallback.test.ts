/**
 * Builtin geometry stood in for items the game draws in code. Each branch is
 * keyed on the item name, and must never guess across kinds — a wrong icon
 * reads as correct, which is worse than none.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { builtinPackPath } from '../src/builtin.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { renderEntityFallback } from '../src/render/entity-fallback.ts';
import { FolderResourceManager, LayeredResourceManager } from '../src/resources/manager.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { TextureLoader } from '../src/textures/loader.ts';

async function sheet(width: number, height: number): Promise<Buffer> {
	return sharp({ create: { width, height, channels: 4, background: { r: 120, g: 90, b: 60, alpha: 1 } } })
		.png()
		.toBuffer();
}

/** Vanilla parents the builtin pack chains to, which no stub pack carries. */
function withVanillaStubs(resources: MapResourceManager): MapResourceManager {
	return resources
		.set('model', 'minecraft:item/template_shulker_box', JSON.stringify({ parent: 'minecraft:block/block' }))
		.set('model', 'minecraft:block/block', JSON.stringify({
			display: { gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
		}));
}

async function render(resources: MapResourceManager, id: string): Promise<unknown> {
	const layered = new LayeredResourceManager([new FolderResourceManager(builtinPackPath('modern')), withVanillaStubs(resources)]);
	const models = new ModelLoader(layered);
	const textures = new TextureLoader(layered);
	return renderEntityFallback(id, models, textures, layered, {
		size: 16,
		quality: 1,
		lightingProfile: 'modern',
		resources: layered,
	});
}

describe('shield fallback', () => {
	it('puts a mod\'s own shield face on the builtin board', async () => {
		const resources = new MapResourceManager()
			.set('texture', 'cyclic:entity/shield/bone_base_nopattern', await sheet(64, 64));
		expect(await render(resources, 'cyclic:shield_bone_blocking')).not.toBeNull();
	});

	it('still draws a shield with no mod sheet, using the vanilla face', async () => {
		// The board is the same either way; only the face is in question, and the
		// builtin model already binds vanilla's.
		const resources = new MapResourceManager()
			.set('texture', 'minecraft:entity/shield/shield_base_nopattern', await sheet(64, 64));
		expect(await render(resources, 'somemod:iron_shield')).not.toBeNull();
	});

	it('does not treat an unrelated item as a shield', async () => {
		expect(await render(new MapResourceManager(), 'somemod:copper_ingot')).toBeNull();
	});
});

describe('shulker box fallback', () => {
	it('ignores a tier sheet that is only trim', async () => {
		// Sophisticated Storage's tier sheets composite over the vanilla box; worn
		// alone they leave floating corners, so the vanilla skin stands in.
		const trim = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 200, g: 170, b: 60, alpha: 0 } } })
			.png()
			.toBuffer();
		const resources = new MapResourceManager()
			.set('texture', 'sophisticatedstorage:entity/shulker_box/gold_tier', trim)
			.set('texture', 'minecraft:entity/shulker/shulker', await sheet(64, 64));
		expect(await render(resources, 'sophisticatedstorage:gold_shulker_box')).not.toBeNull();
	});

	it('uses a mod sheet that is a whole skin', async () => {
		const resources = new MapResourceManager()
			.set('texture', 'somemod:entity/shulker/fancy_shulker_box', await sheet(64, 64))
			.set('texture', 'minecraft:entity/shulker/shulker', await sheet(64, 64));
		expect(await render(resources, 'somemod:fancy_shulker_box')).not.toBeNull();
	});
});

describe('mob head fallback', () => {
	it('declines a creature sheet that is not a skin layout', async () => {
		// A 100x40 sheet unwraps into confetti on head geometry; no icon beats a
		// wrong one.
		const resources = new MapResourceManager()
			.set('texture', 'spectrum:entity/lizard/lizard', await sheet(100, 40));
		expect(await render(resources, 'spectrum:lizard_head')).toBeNull();
	});

	it('accepts a sheet sized like a real skin', async () => {
		const resources = new MapResourceManager()
			.set('texture', 'spectrum:entity/kindling/kindling', await sheet(64, 32));
		expect(await render(resources, 'spectrum:kindling_head')).not.toBeNull();
	});
});
