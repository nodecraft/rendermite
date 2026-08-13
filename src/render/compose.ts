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
		const x = pixel % width;
		const y = Math.floor(pixel / width);
		const localPixel = (face: FaceBuffer): number | null => {
			const localX = x - face.x;
			const localY = y - face.y;
			return localX >= 0 && localX < face.width && localY >= 0 && localY < face.height
				? localY * face.width + localX
				: null;
		};
		// Stable insertion-friendly sort per pixel, matching upstream's usort semantics.
		order.sort((a, b) => {
			const aPixel = localPixel(a);
			const bPixel = localPixel(b);
			return (aPixel === null ? 0 : a.depths[aPixel]) - (bPixel === null ? 0 : b.depths[bPixel]);
		});
		const offset = pixel * 4;
		for (const face of order) {
			const facePixel = localPixel(face);
			if (facePixel === null) {
				continue;
			}
			const faceOffset = facePixel * 4;
			const alpha = face.colors[faceOffset + 3];
			if (alpha > 0) {
				blendPixel(out, offset, face.colors[faceOffset], face.colors[faceOffset + 1], face.colors[faceOffset + 2], alpha);
			}
		}
	}
	return { width, height, data: out };
}
