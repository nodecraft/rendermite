/**
 * Three render paths shade a face: `renderFace` caches pre-shaded textures until
 * a byte budget runs out, `renderObjModel` does the same per material and light
 * bucket, and both then fall through to shading each sample as the rasterizer
 * writes it. The fallback exists because the clones are otherwise unbounded —
 * one 1,493-triangle OBJ wanted 1.3 GB for a single 64px icon.
 *
 * Those two strategies are only interchangeable if they are pixel-identical, and
 * a drift would be near-invisible: each renders plausibly on its own, just
 * differently from the other, and only on the models big enough to cross the
 * budget. This pins the invariant every one of those call sites stands on.
 */

import { describe, expect, it } from 'vitest';

import {
	cloneFloatTexture,
	darkenTexture,
	scaleTextureAlpha,
	tintTexture,
} from '../src/render/blend.ts';
import {
	RowCursor,
	clearFaceBuffer,
	createFaceBuffer,
	drawTexturedTriangle,
} from '../src/render/rasterizer.ts';

import type { FaceShading, FloatTexture } from '../src/render/blend.ts';
import type { FaceBuffer } from '../src/render/rasterizer.ts';

/** A small sheet with per-pixel variation, so a channel mix-up cannot pass. */
function sourceTexture(alpha: number): FloatTexture {
	const width = 8;
	const height = 8;
	const data = new Float64Array(width * height * 4);
	for (let index = 0; index < width * height; index++) {
		data[index * 4] = (index % width) / (width - 1);
		data[index * 4 + 1] = Math.floor(index / width) / (height - 1);
		data[index * 4 + 2] = ((index * 3) % width) / (width - 1);
		data[index * 4 + 3] = alpha;
	}
	return { width, height, data };
}

/** Two triangles covering a quad, so most of the sheet is sampled. */
function draw(source: FloatTexture, shading: FaceShading | null): FaceBuffer {
	const buffer = createFaceBuffer(24, 24);
	clearFaceBuffer(buffer);
	const cursor = new RowCursor();
	const corner = (x: number, y: number, textureU: number, textureV: number): { x: number; y: number; u: number; v: number; depth: number; } => {
		return { x, y, u: textureU, v: textureV, depth: 0.5 };
	};
	drawTexturedTriangle(corner(2, 2, 0, 0), corner(20, 2, 1, 0), corner(20, 20, 1, 1), buffer, source, cursor, shading);
	drawTexturedTriangle(corner(2, 2, 0, 0), corner(20, 20, 1, 1), corner(2, 20, 0, 1), buffer, source, cursor, shading);
	return buffer;
}

function differingChannels(left: FaceBuffer, right: FaceBuffer): number {
	let differing = 0;
	for (let index = 0; index < left.colors.length; index++) {
		if (left.colors[index] !== right.colors[index]) {
			differing++;
		}
	}
	return differing;
}

describe('sample-time shading matches a pre-shaded clone', () => {
	// darkness 0 is the emissive case; 1 is a fully unlit face.
	for (const alpha of [1, 0.5]) {
		for (const darkness of [0, 0.25, 0.6, 1]) {
			it(`agrees at alpha ${alpha}, darkness ${darkness}`, () => {
				const source = sourceTexture(alpha);

				// What the cache does: darken a copy up front, sample it plainly.
				const preShaded = cloneFloatTexture(source);
				darkenTexture(preShaded, darkness, 0, 0, preShaded.width, preShaded.height);

				const viaClone = draw(preShaded, null);
				const viaSamples = draw(source, {
					tint: null,
					darkness,
					alpha: 1,
					windowX1: 0,
					windowY1: 0,
					windowX2: source.width - 1,
					windowY2: source.height - 1,
				});

				expect(viaSamples.colors.length).toBe(viaClone.colors.length);
				expect(differingChannels(viaClone, viaSamples)).toBe(0);
			});
		}
	}

	it('agrees with a tint and a translucent face, the way renderFace shades', () => {
		// renderFace's cached branch runs tint, then darken, then alpha over the
		// UV window; shadeTexel has to reproduce that whole order, not just darken.
		const source = sourceTexture(1);
		const tint = { r: 0.6, g: 0.9, b: 0.3 };
		const darkness = 0.35;
		const faceAlpha = 0.75;

		const preShaded = cloneFloatTexture(source);
		tintTexture(preShaded, tint.r, tint.g, tint.b);
		darkenTexture(preShaded, darkness, 0, 0, preShaded.width, preShaded.height);
		scaleTextureAlpha(preShaded, faceAlpha, 0, 0, preShaded.width, preShaded.height);

		const viaClone = draw(preShaded, null);
		const viaSamples = draw(source, {
			tint,
			darkness,
			alpha: faceAlpha,
			windowX1: 0,
			windowY1: 0,
			windowX2: source.width - 1,
			windowY2: source.height - 1,
		});

		expect(differingChannels(viaClone, viaSamples)).toBe(0);
	});

	it('leaves a sample outside the UV window unshaded', () => {
		// The rasterizer biases its cursor and overdraws a pixel, so a sample can
		// land outside the face's own rect. Darkening there would diverge from the
		// cached path, whose darkenTexture only touches the window.
		const source = sourceTexture(1);
		const outside = draw(source, {
			tint: null,
			darkness: 1,
			alpha: 1,
			// An empty window: nothing sampled may be darkened.
			windowX1: 0,
			windowY1: 0,
			windowX2: -1,
			windowY2: -1,
		});
		const untouched = draw(source, null);
		expect(differingChannels(untouched, outside)).toBe(0);
	});
});
