/**
 * Combined animation timelines are the corpus' worst outliers: independently
 * animated layers multiply out to a least-common-multiple cycle, and one modded
 * item was measured at 8,640 frames / 12 minutes / 29.9 MB. The renderer must
 * bound that, and must do it by sampling the whole cycle — a prefix of a
 * minutes-long animation is just its first few seconds.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ModelLoader } from '../src/models/loader.ts';
import { renderModelFrames } from '../src/render/renderer.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { TextureLoader } from '../src/textures/loader.ts';

/** A vertical strip of `frames` solid 16px tiles, each a different shade. */
async function strip(frames: number): Promise<Buffer> {
	const pixels = Buffer.alloc(16 * 16 * frames * 4);
	for (let frame = 0; frame < frames; frame++) {
		const shade = Math.round(255 * ((frame + 1) / frames));
		for (let pixel = 0; pixel < 16 * 16; pixel++) {
			const offset = ((frame * 16 * 16) + pixel) * 4;
			pixels[offset] = shade;
			pixels[offset + 1] = 255 - shade;
			pixels[offset + 2] = shade;
			pixels[offset + 3] = 255;
		}
	}
	return sharp(pixels, { raw: { width: 16, height: 16 * frames, channels: 4 } }).png().toBuffer();
}

interface Layer {
	frames: number;
	frametime?: number;
	frameList?: Array<number | { index: number; time: number; }>;
	interpolate?: boolean;
}

async function animatedItem(layers: Layer[]): Promise<{ models: ModelLoader; textures: TextureLoader; }> {
	const resources = new MapResourceManager();
	const textureRefs: Record<string, string> = {};
	for (const [index, layer] of layers.entries()) {
		const name = `anim:item/layer${index}`;
		textureRefs[`layer${index}`] = name;
		resources.set('texture', name, await strip(layer.frames));
		resources.set('textureMeta', name, JSON.stringify({
			animation: {
				frametime: layer.frametime ?? 1,
				...layer.frameList && { frames: layer.frameList },
				...layer.interpolate && { interpolate: true },
			},
		}));
	}
	resources.set('model', 'anim:item/thing', JSON.stringify({
		parent: 'builtin/generated',
		textures: textureRefs,
	}));
	return { models: new ModelLoader(resources), textures: new TextureLoader(resources) };
}

async function render(layers: Layer[], maxFrames?: number) {
	const { models, textures } = await animatedItem(layers);
	return renderModelFrames(await models.load('anim:item/thing'), textures, {
		size: 16,
		quality: 1,
		lightingProfile: 'modern',
		...maxFrames !== undefined && { animation: { maxFrames } },
	});
}

describe('animation timeline bounds', () => {
	it('emits one frame per change for a simple animation, with the source timing', async () => {
		const { frames, delaysMs, animation } = await render([{ frames: 4, frametime: 2 }]);
		expect(frames).toHaveLength(4);
		expect(delaysMs).toEqual([100, 100, 100, 100]);
		expect(animation).toMatchObject({ ticks: 8, sampled: false });
	});

	it('coalesces repeated frames into a single longer frame', async () => {
		// The frame list shows 0,0,0 then 1 — three ticks of one image, not three images.
		const { frames, delaysMs } = await render([{ frames: 2, frameList: [0, 0, 0, 1] }]);
		expect(frames).toHaveLength(2);
		expect(delaysMs).toEqual([150, 50]);
	});

	it('bounds a least-common-multiple explosion and still covers the whole cycle', async () => {
		// Periods 15, 28 and 33 ticks combine into a 4,620-tick (3.8 minute) cycle.
		const { frames, delaysMs, animation } = await render([
			{ frames: 5, frametime: 3 },
			{ frames: 4, frametime: 7 },
			{ frames: 3, frametime: 11 },
		]);
		expect(animation!.ticks).toBe(4620);
		expect(animation!.sampled).toBe(true);
		expect(frames.length).toBeLessThanOrEqual(128);
		// The emitted frames span the cycle rather than its opening seconds, and
		// the loop still lasts exactly as long as the source timeline.
		expect(delaysMs.reduce((total, delay) => total + delay, 0)).toBe(4620 * 50);
		expect(Math.max(...delaysMs)).toBeLessThanOrEqual(3 * Math.ceil(4620 / 128) * 50);
	});

	it('honours an explicit frame cap', async () => {
		const { frames } = await render([
			{ frames: 5, frametime: 3 },
			{ frames: 4, frametime: 7 },
			{ frames: 3, frametime: 11 },
		], 16);
		expect(frames.length).toBeLessThanOrEqual(16);
	});

	it('samples interpolated animations, which differ at every tick', async () => {
		const { frames, delaysMs, animation } = await render([{ frames: 4, frametime: 40, interpolate: true }]);
		expect(animation).toMatchObject({ ticks: 160, interpolated: true, sampled: true });
		expect(frames.length).toBeLessThanOrEqual(128);
		expect(frames.length).toBeGreaterThan(4);
		expect(delaysMs.reduce((total, delay) => total + delay, 0)).toBe(160 * 50);
	});
});
