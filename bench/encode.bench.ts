/**
 * Encoding benchmarks. Encoding is roughly half the per-item wall time of a run
 * and its settings trade bytes against CPU, so these measure speed while the
 * report tracks the encoded size alongside it — bytes are deterministic, which
 * makes them the more reliable of the two signals on a hosted runner.
 *
 * Setup is top-level because Vitest does not run suite hooks in benchmark mode.
 */

import { bench, describe } from 'vitest';

import { BENCH_VERSION } from './global-setup.ts';
import { defaultProperties } from '../src/items/definition.ts';
import { resolveItem } from '../src/items/discovery.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { encodeAnimatedIcon } from '../src/output/encode.ts';
import { renderModelFrames } from '../src/render/renderer.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { TextureLoader } from '../src/textures/loader.ts';
import { vanillaJar } from '../test/fixtures/index.ts';

import type { FloatTexture } from '../src/render/blend.ts';

const STATIC_ITEMS = ['minecraft:diamond_sword', 'minecraft:stone', 'minecraft:bookshelf'] as const;
const ANIMATED_ITEM = 'minecraft:magma_block';

interface Icon {
	frames: FloatTexture[];
	delaysMs: number[];
}

const resources = new JarResourceManager(vanillaJar(BENCH_VERSION));
const models = new ModelLoader(resources);
const textures = new TextureLoader(resources);

async function icon(id: string): Promise<Icon> {
	const instructions = await resolveItem(resources, id, defaultProperties());
	const model = await models.load(instructions[0].model);
	const { frames, delaysMs } = await renderModelFrames(model, textures, {
		size: 64,
		quality: 2,
		lightingProfile: 'modern',
	});
	return { frames, delaysMs };
}

const statics: Icon[] = [];
for (const id of STATIC_ITEMS) {
	statics.push(await icon(id));
}
const animated = await icon(ANIMATED_ITEM);
if (animated.frames.length < 2) {
	throw new Error(`${ANIMATED_ITEM} rendered ${animated.frames.length} frames; the animated benchmark needs more`);
}

describe('encode', () => {
	bench('three static icons to PNG + WebP', async () => {
		let bytes = 0;
		for (const item of statics) {
			const encoded = await encodeAnimatedIcon(item.frames, item.delaysMs, { webp: true });
			bytes += encoded.png.length;
		}
		if (bytes === 0) {
			throw new Error('benchmark encoded nothing');
		}
	}, { time: 2000 });

	bench('one animated icon to PNG + animated WebP', async () => {
		await encodeAnimatedIcon(animated.frames, animated.delaysMs, { webp: true });
	}, { time: 2000 });
});
