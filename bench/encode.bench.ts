/**
 * Encoding benchmarks. Encoding is roughly half the per-item wall time of a run
 * and its settings trade bytes against CPU, so a regression here is expensive
 * and easy to introduce.
 *
 * Both sides encode the *same* frames, rendered once by this tree, so the
 * comparison isolates the encoder: a pull request that changes what the
 * renderer emits would otherwise hand the two encoders different pixels and
 * report the difference as an encoding change. `FloatTexture` is a plain
 * width/height/Float64Array record, which is what makes handing one tree's
 * frames to the other's encoder safe.
 *
 * Setup is top-level because Vitest does not run suite hooks in benchmark mode.
 */

import { BENCH_VERSION } from './global-setup.ts';
import { prepareSides } from './sides.ts';
import {
	JarResourceManager,
	ModelLoader,
	TextureLoader,
	defaultProperties,
	renderModelFrames,
	resolveItem,
} from './subject.ts';
import { vanillaJar } from '../test/fixtures/index.ts';

import type { FloatTexture } from './subject.ts';

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

const sides = await prepareSides((subject) => {
	return {
		encode: subject.encodeAnimatedIcon,
	};
});

sides.compare('encode', 'three static icons to PNG + WebP', { time: 2000 }, async ({ encode }) => {
	let bytes = 0;
	for (const item of statics) {
		const encoded = await encode(item.frames, item.delaysMs, { webp: true });
		bytes += encoded.png.length;
	}
	if (bytes === 0) {
		throw new Error('benchmark encoded nothing');
	}
});

sides.compare('encode', 'one animated icon to PNG + animated WebP', { time: 2000 }, async ({ encode }) => {
	await encode(animated.frames, animated.delaysMs, { webp: true });
});
