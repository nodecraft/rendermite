/**
 * Per-pixel painter's compositing, mirroring upstream Model::combineFaceImages:
 * at each pixel, faces sorted ascending by that pixel's depth value (0 where the
 * rasterizer never wrote depth — the overdraw band relies on sorting beneath),
 * then source-over blended in that order when alpha > 0.
 *
 * Upstream re-sorts one persistent array, so each pixel's sort is really a
 * stable partition: faces the pixel misses keep their order, faces with depth
 * move to the end in depth order. That reordering is invariant under taking
 * subsets, so instead of touching every face at every pixel we keep a rank per
 * face (a moved face gets a fresh, higher rank) and visit only the faces whose
 * bounding box contains the pixel. Same order, same pixels, sublinear in faces.
 */

import { blendPixel } from './blend.ts';

import type { FloatTexture } from './blend.ts';
import type { FaceBuffer } from './rasterizer.ts';

export function combineFaceBuffers(width: number, height: number, faces: FaceBuffer[]): FloatTexture {
	const out = new Float64Array(width * height * 4);
	const count = faces.length;
	if (count === 0) {
		return { width, height, data: out };
	}

	// Row index over face bounding boxes, CSR-style: rowFaces[rowStart[y] …
	// rowStart[y + 1]) are the faces that can cover row y, in face order.
	const rowCounts = new Int32Array(height + 1);
	for (const face of faces) {
		const endY = Math.min(face.y + face.height, height);
		for (let y = Math.max(face.y, 0); y < endY; y++) {
			rowCounts[y]++;
		}
	}
	const rowStart = new Int32Array(height + 1);
	for (let y = 0; y < height; y++) {
		rowStart[y + 1] = rowStart[y] + rowCounts[y];
	}
	const cursor = [...rowStart];
	const rowFaces = new Int32Array(rowStart[height]);
	for (let index = 0; index < count; index++) {
		const face = faces[index];
		const endY = Math.min(face.y + face.height, height);
		for (let y = Math.max(face.y, 0); y < endY; y++) {
			rowFaces[cursor[y]++] = index;
		}
	}

	// Rank encodes the persistent array's current order; ties never occur.
	const rank = new Float64Array(count);
	for (let index = 0; index < count; index++) {
		rank[index] = index;
	}
	let nextRank = count;

	// Reused per pixel: faces with no depth here (they keep their rank) and
	// faces with depth (they sort by depth and move to the end).
	const flat = new Int32Array(count);
	const flatRank = new Float64Array(count);
	const deep = new Int32Array(count);
	const deepDepth = new Float64Array(count);
	const deepRank = new Float64Array(count);

	for (let y = 0; y < height; y++) {
		const start = rowStart[y];
		const end = rowStart[y + 1];
		if (start === end) {
			continue;
		}
		for (let x = 0; x < width; x++) {
			let flatCount = 0;
			let deepCount = 0;
			for (let slot = start; slot < end; slot++) {
				const index = rowFaces[slot];
				const face = faces[index];
				const localX = x - face.x;
				if (localX < 0 || localX >= face.width) {
					continue;
				}
				const localPixel = (y - face.y) * face.width + localX;
				const depth = face.depths[localPixel];
				if (depth > 0) {
					// Insertion sort by depth, then rank — the stable order the
					// full-array sort would have produced.
					let slotIndex = deepCount++;
					while (slotIndex > 0
						&& (deepDepth[slotIndex - 1] > depth
							|| (deepDepth[slotIndex - 1] === depth && deepRank[slotIndex - 1] > rank[index]))) {
						deep[slotIndex] = deep[slotIndex - 1];
						deepDepth[slotIndex] = deepDepth[slotIndex - 1];
						deepRank[slotIndex] = deepRank[slotIndex - 1];
						slotIndex--;
					}
					deep[slotIndex] = index;
					deepDepth[slotIndex] = depth;
					deepRank[slotIndex] = rank[index];
				} else if (face.colors[localPixel * 4 + 3] > 0) {
					// A transparent sample with no depth neither blends nor moves in
					// the order, so it never needs a place in it.
					let slotIndex = flatCount++;
					while (slotIndex > 0 && flatRank[slotIndex - 1] > rank[index]) {
						flat[slotIndex] = flat[slotIndex - 1];
						flatRank[slotIndex] = flatRank[slotIndex - 1];
						slotIndex--;
					}
					flat[slotIndex] = index;
					flatRank[slotIndex] = rank[index];
				}
			}
			if (flatCount === 0 && deepCount === 0) {
				continue;
			}

			const offset = (y * width + x) * 4;
			for (let i = 0; i < flatCount; i++) {
				blendFace(out, offset, faces[flat[i]], x, y);
			}
			for (let i = 0; i < deepCount; i++) {
				const index = deep[i];
				blendFace(out, offset, faces[index], x, y);
				rank[index] = nextRank++;
			}
		}
	}
	return { width, height, data: out };
}

function blendFace(out: Float64Array, offset: number, face: FaceBuffer, x: number, y: number): void {
	const faceOffset = ((y - face.y) * face.width + (x - face.x)) * 4;
	const alpha = face.colors[faceOffset + 3];
	if (alpha > 0) {
		blendPixel(out, offset, face.colors[faceOffset], face.colors[faceOffset + 1], face.colors[faceOffset + 2], alpha);
	}
}
