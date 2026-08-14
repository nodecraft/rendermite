/**
 * Render-path benchmarks. The item list is fixed rather than discovered so a
 * pull request is compared against the baseline on identical work: each id
 * covers a different code path (flat sprite layers, a plain cube, a many-element
 * model, an animated texture), and every one is rendered once during setup so
 * the measured loop reflects the warm caches a bulk run actually has.
 *
 * Setup is top-level, not in beforeAll: Vitest does not run suite hooks in
 * benchmark mode, and a benchmark over unprepared state reports an
 * impressively fast time for doing nothing.
 */

import { bench, describe } from 'vitest';

import { BENCH_VERSION } from './global-setup.ts';
import { defaultProperties } from '../src/items/definition.ts';
import { resolveItem } from '../src/items/discovery.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { combineFaceBuffers } from '../src/render/compose.ts';
import { createFaceBuffer } from '../src/render/rasterizer.ts';
import { renderModelFrames } from '../src/render/renderer.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { TextureLoader } from '../src/textures/loader.ts';
import { vanillaJar } from '../test/fixtures/index.ts';

import type { ResolvedModel } from '../src/models/loader.ts';
import type { FaceBuffer } from '../src/render/rasterizer.ts';
import type { RenderOptions } from '../src/render/renderer.ts';

/** Flat sprites, plain cubes, multi-element geometry and one animated texture. */
const ITEMS = [
	'minecraft:diamond_sword',
	'minecraft:apple',
	'minecraft:stone',
	'minecraft:oak_planks',
	'minecraft:bookshelf',
	'minecraft:oak_fence',
	'minecraft:stone_brick_stairs',
	'minecraft:lantern',
	'minecraft:torch',
	'minecraft:glowstone',
] as const;
const ANIMATED_ITEM = 'minecraft:magma_block';
const COMPLEX_ITEM = 'minecraft:stone_brick_stairs';

const OPTIONS: RenderOptions = {
	size: 64,
	quality: 2,
	lightingProfile: 'modern',
};

const resources = new JarResourceManager(vanillaJar(BENCH_VERSION));
const loader = new ModelLoader(resources);
const textures = new TextureLoader(resources);
const models = new Map<string, ResolvedModel>();

async function render(id: string): Promise<number> {
	const model = models.get(id);
	if (!model) {
		throw new Error(`Benchmark model ${id} was not prepared`);
	}
	const { frames } = await renderModelFrames(model, textures, OPTIONS);
	return frames.length;
}

for (const id of [...ITEMS, ANIMATED_ITEM]) {
	const instructions = await resolveItem(resources, id, defaultProperties());
	models.set(id, await loader.load(instructions[0].model));
	// Warm the caches, and fail here rather than reporting a fast benchmark for
	// an item that never drew anything.
	if (await render(id) === 0) {
		throw new Error(`Benchmark item ${id} rendered no frames`);
	}
}
if (await render(ANIMATED_ITEM) < 2) {
	throw new Error(`Benchmark item ${ANIMATED_ITEM} is not animated in ${BENCH_VERSION}`);
}

describe('render', () => {
	bench('ten items, mixed model kinds', async () => {
		let frames = 0;
		for (const id of ITEMS) {
			frames += await render(id);
		}
		if (frames < ITEMS.length) {
			throw new Error('benchmark rendered less than one frame per item');
		}
	}, { time: 2000 });

	bench('one many-element block model', async () => {
		await render(COMPLEX_ITEM);
	}, { time: 1000 });

	bench('one animated item, every frame', async () => {
		await render(ANIMATED_ITEM);
	}, { time: 2000 });
});

describe('compose', () => {
	// Painter's compositing over many small faces is the shape complex block
	// models produce, and it was the single hottest function in the renderer.
	const SIZE = 128;
	const EXTENT = 12;
	const faces: FaceBuffer[] = Array.from({ length: 300 }, (_, index) => {
		const buffer = createFaceBuffer(EXTENT, EXTENT);
		buffer.x = (index * 7) % (SIZE - EXTENT);
		buffer.y = (index * 13) % (SIZE - EXTENT);
		for (let pixel = 0; pixel < EXTENT * EXTENT; pixel++) {
			buffer.colors[pixel * 4] = 0.5;
			buffer.colors[pixel * 4 + 1] = 0.25;
			buffer.colors[pixel * 4 + 2] = 0.75;
			buffer.colors[pixel * 4 + 3] = 0.6;
			buffer.depths[pixel] = ((index * 31 + pixel) % 97) / 97;
		}
		return buffer;
	});

	bench('300 overlapping faces into a 128px image', () => {
		combineFaceBuffers(SIZE, SIZE, faces);
	}, { time: 1000 });
});
