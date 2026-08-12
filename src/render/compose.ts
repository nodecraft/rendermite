/**
 * Per-pixel painter's compositing, mirroring upstream Model::combineFaceImages:
 * at each pixel, faces sorted ascending by that pixel's depth value (0 where the
 * rasterizer never wrote depth — the overdraw band relies on sorting beneath),
 * then source-over blended in that order when alpha > 0.
 */

import { blendPixel } from './blend.ts';

import type { FloatTexture } from './blend.ts';
import type { FaceBuffer } from './rasterizer.ts';

export function combineFaceBuffers(width: number, height: number, faces: FaceBuffer[]): FloatTexture {
	const out = new Float64Array(width * height * 4);
	const order = [...faces];
	for (let pixel = 0; pixel < width * height; pixel++) {
		// Stable insertion-friendly sort per pixel, matching upstream's usort semantics.
		order.sort((a, b) => a.depths[pixel] - b.depths[pixel]);
		const offset = pixel * 4;
		for (const face of order) {
			const alpha = face.colors[offset + 3];
			if (alpha > 0) {
				blendPixel(out, offset, face.colors[offset], face.colors[offset + 1], face.colors[offset + 2], alpha);
			}
		}
	}
	return { width, height, data: out };
}
