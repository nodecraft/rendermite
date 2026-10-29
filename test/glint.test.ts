import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { bakeGlint } from '../src/output/glint.ts';

/** A 128px black glint texture with its first two texel columns white. */
async function stripedTexture(): Promise<Buffer> {
	const pixels = Buffer.alloc(128 * 128 * 3);
	for (let y = 0; y < 128; y++) {
		for (const x of [0, 1]) {
			pixels.fill(255, (y * 128 + x) * 3, (y * 128 + x + 1) * 3);
		}
	}
	return sharp(pixels, { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
}

describe('bakeGlint', () => {
	it('bakes at the 512px tile size the stylesheet draws it at', async () => {
		const { width, height } = await sharp(await bakeGlint(await stripedTexture())).metadata();
		expect([width, height]).toEqual([512, 512]);
	});

	it('blurs across the wrapped edge so the repeating tile has no seam', async () => {
		const { data, info } = await sharp(await bakeGlint(await stripedTexture())).raw().toBuffer({ resolveWithObject: true });
		const red = (x: number) => data[(256 * info.width + x) * info.channels];
		// The white stripe sits at the left edge, so only a wrapping blur lights the right edge.
		expect(red(511)).toBeGreaterThan(32);
		expect(red(256)).toBe(0);
	});
});
