import { describe, expect, it } from 'vitest';

import { legacyTintsForChain } from '../src/render/legacy-tints.ts';
import { resolveTint } from '../src/render/tints.ts';

import type { Texture, TextureLoader } from '../src/textures/loader.ts';

/** No colormap is read for fixed colors, so the loader is never called. */
const noTextures = {} as TextureLoader;

/** A 2×2 colormap; sampling the center clamps to the last pixel. */
function colormap(center: [number, number, number]): TextureLoader {
	const data = new Uint8ClampedArray([
		0,
		0,
		0,
		255,
		0,
		0,
		0,
		255,
		0,
		0,
		0,
		255,
		...center,
		255,
	]);
	return { load: async (): Promise<Texture> => {
		return { width: 2, height: 2, data };
	} } as unknown as TextureLoader;
}

describe('legacy vanilla tints', () => {
	it('applies both spawn egg layers', async () => {
		expect(await legacyTintsForChain(['minecraft:item/creeper_spawn_egg', 'minecraft:item/generated'], noTextures)).toEqual([
			{ r: 0x0D / 255, g: 0xA5 / 255, b: 0x0B / 255 },
			{ r: 0, g: 0, b: 0 },
		]);
	});

	it('applies single-layer potion and banner colors', async () => {
		expect(await legacyTintsForChain(['minecraft:item/splash_potion'], noTextures)).toHaveLength(1);
		// Pre-1.13 ships one banner item, defaulting to white.
		expect(await legacyTintsForChain(['minecraft:item/banner'], noTextures)).toEqual([
			{ r: 0xF6 / 255, g: 0xFC / 255, b: 0xFB / 255 },
		]);
	});

	it('lets the deepest chain entry win', async () => {
		// An item model's own tint beats the block model it parents.
		const tints = await legacyTintsForChain(['minecraft:item/lily_pad', 'minecraft:block/grass_block'], colormap([10, 200, 20]));
		expect(tints).toEqual([{ r: 10 / 255, g: 200 / 255, b: 20 / 255 }]);
	});

	it('samples the foliage and grass colormaps', async () => {
		expect(await legacyTintsForChain(['minecraft:block/birch_leaves'], colormap([40, 160, 60]))).toEqual([
			{ r: 40 / 255, g: 160 / 255, b: 60 / 255 },
		]);
		expect(await legacyTintsForChain(['minecraft:block/grass_block'], colormap([50, 150, 70]))).toEqual([
			{ r: 50 / 255, g: 150 / 255, b: 70 / 255 },
		]);
	});

	it('falls back to magenta when the colormap is missing', async () => {
		const missing = { load: async (): Promise<Texture | null> => null } as unknown as TextureLoader;
		expect(await legacyTintsForChain(['minecraft:item/fern'], missing)).toEqual([{ r: 1, g: 0, b: 1 }]);
	});

	it('tints nothing for untinted or modded models', async () => {
		expect(await legacyTintsForChain(['minecraft:item/stone', 'minecraft:item/generated'], noTextures)).toBeNull();
		// Mod tints are sourced as item definitions instead (src/mods/tints.ts).
		expect(await legacyTintsForChain(['advanced_ae:item/quantum_helmet', 'minecraft:item/generated'], noTextures)).toBeNull();
	});
});

describe('AE2 tint sources', () => {
	const context = { textures: {} as never };

	it('resolves an ae2:color variant from the AEColor palette', async () => {
		// AEColor states dark/medium/bright only in its static initialiser.
		expect(await resolveTint({ type: 'ae2:color', color: 'fluix', variant: 'dark' } as never, context))
			.toEqual({ r: 0x5A / 255, g: 0x47 / 255, b: 0x9E / 255 });
		expect(await resolveTint({ type: 'ae2:color', color: 'fluix', variant: 'bright' } as never, context))
			.toEqual({ r: 0xE2 / 255, g: 0xA3 / 255, b: 0xE3 / 255 });
	});

	it('defaults an ae2:color with no variant to medium', async () => {
		expect(await resolveTint({ type: 'ae2:color', color: 'green' } as never, context))
			.toEqual({ r: 0x17 / 255, g: 0xB8 / 255, b: 0x6D / 255 });
	});

	it('rejects a colour AEColor does not define', async () => {
		await expect(resolveTint({ type: 'ae2:color', color: 'chartreuse' } as never, context))
			.rejects.toThrow(/ae2:color/);
	});

	it('shows a storage cell as empty and a portable cell in its stock colour', async () => {
		expect(await resolveTint({ type: 'ae2:storage_cell_state' } as never, context))
			.toEqual({ r: 0, g: 1, b: 0 });
		expect(await resolveTint({ type: 'ae2:portable_cell_color' } as never, context))
			.toEqual({ r: 0x80 / 255, g: 0xCF / 255, b: 0xFF / 255 });
	});
});

describe('tint types no release states', () => {
	const context = { textures: {} as never };

	it('costs the colour, not the icon, when a mod computes its tint in code', async () => {
		// mysticalagriculture:augment and silentgear:material are resolved from the
		// registry at runtime with no stated default. The sprite exists either way,
		// so an unresolved tint must not fail the item.
		expect(await resolveTint({ type: 'mysticalagriculture:augment', id: 'x', index: 0 } as never, context)).toBeNull();
		expect(await resolveTint({ type: 'silentgear:material' } as never, context)).toBeNull();
	});

	it('still prefers a stated default over dropping the tint', async () => {
		expect(await resolveTint({ type: 'somemod:custom', default: 0xFF_00_00 } as never, context))
			.toEqual({ r: 1, g: 0, b: 0 });
	});

	it('still rejects a value it cannot parse', async () => {
		await expect(resolveTint({ type: 'minecraft:constant', value: 'nonsense' } as never, context))
			.rejects.toThrow(/Unparseable/);
	});
});
