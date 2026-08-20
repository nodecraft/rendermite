/**
 * Render-path benchmarks. The item list is fixed rather than discovered so both
 * sides are compared on identical work: each id covers a different code path
 * (flat sprite layers, a plain cube, a many-element model, an animated
 * texture), and every one is rendered once during setup so the measured loop
 * reflects the warm caches a bulk run actually has.
 *
 * Setup runs once per side, at collection time: Vitest does not run suite hooks
 * in benchmark mode, and a benchmark over unprepared state reports an
 * impressively fast time for doing nothing.
 */

import { BENCH_VERSION } from './global-setup.ts';
import { prepareSides } from './sides.ts';
import { vanillaJar } from '../test/fixtures/index.ts';

import type { FaceBuffer, RenderOptions, ResolvedModel } from './subject.ts';

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

/** Painter's compositing over many small faces, the shape complex block models produce. */
const COMPOSE_SIZE = 128;
const COMPOSE_EXTENT = 12;
const COMPOSE_FACES = 300;

const sides = await prepareSides(async (subject) => {
	const resources = new subject.JarResourceManager(vanillaJar(BENCH_VERSION));
	const loader = new subject.ModelLoader(resources);
	const textures = new subject.TextureLoader(resources);
	const models = new Map<string, ResolvedModel>();

	const render = async (id: string): Promise<number> => {
		const model = models.get(id);
		if (!model) {
			throw new Error(`Benchmark model ${id} was not prepared`);
		}
		const { frames } = await subject.renderModelFrames(model, textures, OPTIONS);
		return frames.length;
	};

	for (const id of [...ITEMS, ANIMATED_ITEM]) {
		const instructions = await subject.resolveItem(resources, id, subject.defaultProperties());
		models.set(id, await loader.load(instructions[0].model));
		// Warm the caches, and fail here rather than reporting a fast benchmark
		// for an item that never drew anything.
		if (await render(id) === 0) {
			throw new Error(`Benchmark item ${id} rendered no frames`);
		}
	}
	if (await render(ANIMATED_ITEM) < 2) {
		throw new Error(`Benchmark item ${ANIMATED_ITEM} is not animated in ${BENCH_VERSION}`);
	}

	// Built per side: the buffer layout belongs to whichever tree composites it.
	const faces: FaceBuffer[] = Array.from({ length: COMPOSE_FACES }, (_, index) => {
		const buffer = subject.createFaceBuffer(COMPOSE_EXTENT, COMPOSE_EXTENT);
		buffer.x = (index * 7) % (COMPOSE_SIZE - COMPOSE_EXTENT);
		buffer.y = (index * 13) % (COMPOSE_SIZE - COMPOSE_EXTENT);
		for (let pixel = 0; pixel < COMPOSE_EXTENT * COMPOSE_EXTENT; pixel++) {
			buffer.colors[pixel * 4] = 0.5;
			buffer.colors[pixel * 4 + 1] = 0.25;
			buffer.colors[pixel * 4 + 2] = 0.75;
			buffer.colors[pixel * 4 + 3] = 0.6;
			buffer.depths[pixel] = ((index * 31 + pixel) % 97) / 97;
		}
		return buffer;
	});

	return {
		render,
		compose: (): void => {
			subject.combineFaceBuffers(COMPOSE_SIZE, COMPOSE_SIZE, faces);
		},
	};
});

sides.compare('render', 'ten items, mixed model kinds', { time: 2000 }, async ({ render }) => {
	let frames = 0;
	for (const id of ITEMS) {
		frames += await render(id);
	}
	if (frames < ITEMS.length) {
		throw new Error('benchmark rendered less than one frame per item');
	}
});

// 2s rather than 1s: at ~10ms an iteration a shorter run left a margin of
// error above 20% on some cases, which is wider than anything it could report.
sides.compare('render', 'one many-element block model', { time: 2000 }, async ({ render }) => {
	await render(COMPLEX_ITEM);
});

/*
 * The noisiest workload here by a distance: every frame of an animated texture
 * allocates float buffers by the megabyte, and under heap pressure it goes
 * bimodal: one case of the four lands near 100ms an iteration and the rest
 * near 180ms, whichever position it runs in. Twice the budget and the heap
 * headroom `scripts/bench-against.ts` passes both help, neither fixes it, so
 * what actually keeps it from reporting a phantom 2x is the palindrome: the
 * fast case never lands in both orderings.
 */
sides.compare('render', 'one animated item, every frame', { time: 4000 }, async ({ render }) => {
	await render(ANIMATED_ITEM);
});

sides.compare('compose', '300 overlapping faces into a 128px image', { time: 1000 }, ({ compose }) => {
	compose();
});
