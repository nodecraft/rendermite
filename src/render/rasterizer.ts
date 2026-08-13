/**
 * Faithful port of renderchest's TriangleRasterizer (scanline, nearest-neighbour
 * sampling by truncation, 0.3 sub-texel start bias, 1px color overdraw with
 * depth written only inside the span). See docs/research/renderchest-spec.md §4.4.
 */

import type { FloatTexture } from './blend.ts';

/** Per-face private color + depth buffers, image sized. */
export interface FaceBuffer {
	/** Position within the final image (full-size scratch buffers start at 0,0). */
	x: number;
	y: number;
	width: number;
	height: number;
	/** RGBA float, overwritten (not blended) by the rasterizer. */
	colors: Float64Array;
	/** Depth per pixel; 0 where never written — the overdraw band relies on that. */
	depths: Float64Array;
}

export function createFaceBuffer(width: number, height: number): FaceBuffer {
	return {
		x: 0,
		y: 0,
		width,
		height,
		colors: new Float64Array(width * height * 4),
		depths: new Float64Array(width * height),
	};
}

/**
 * Retain only the rectangle containing visible pixels. Complex block models can
 * contain thousands of tiny faces; keeping a full icon-sized color/depth buffer
 * for each one turns a 64px render into gigabytes of transient memory.
 */
export function compactFaceBuffer(buffer: FaceBuffer): FaceBuffer | null {
	let minX = buffer.width;
	let minY = buffer.height;
	let maxX = -1;
	let maxY = -1;
	for (let y = 0; y < buffer.height; y++) {
		for (let x = 0; x < buffer.width; x++) {
			if (buffer.colors[(y * buffer.width + x) * 4 + 3] <= 0) {
				continue;
			}
			minX = Math.min(minX, x);
			minY = Math.min(minY, y);
			maxX = Math.max(maxX, x);
			maxY = Math.max(maxY, y);
		}
	}
	if (maxX < minX || maxY < minY) {
		return null;
	}

	const width = maxX - minX + 1;
	const height = maxY - minY + 1;
	const colors = new Float64Array(width * height * 4);
	const depths = new Float64Array(width * height);
	for (let y = 0; y < height; y++) {
		const sourcePixel = (minY + y) * buffer.width + minX;
		const targetPixel = y * width;
		colors.set(
			buffer.colors.subarray(sourcePixel * 4, (sourcePixel + width) * 4),
			targetPixel * 4,
		);
		depths.set(buffer.depths.subarray(sourcePixel, sourcePixel + width), targetPixel);
	}
	return { x: buffer.x + minX, y: buffer.y + minY, width, height, colors, depths };
}

export interface RasterPoint {
	x: number;
	y: number;
	u: number;
	v: number;
	depth: number;
}

/**
 * Emulates ImagickPixelIterator's cursor, including the quirk the whole
 * corpus is rendered with: next() on an unconsumed iterator (fresh or just
 * rewound) fetches row 0 instead of advancing. Upstream's moveIterator never
 * calls current(), so the first triangle part after a rewind draws every
 * scanline ONE ROW ABOVE its computed y. Shared by a face's two triangles.
 */
export class RowCursor {
	row = 0;
	consumed = false;

	/** Upstream moveIterator: rewind when past the target, then advance via next(). */
	moveTo(targetRow: number): void {
		if (this.row > targetRow) {
			this.row = 0;
			this.consumed = false;
		}
		const steps = targetRow - this.row;
		for (let i = 0; i < steps; i++) {
			this.next();
		}
	}

	/** current(): marks the row consumed and returns it. */
	current(): number {
		this.consumed = true;
		return this.row;
	}

	next(): void {
		if (this.consumed) {
			this.row++;
		} else {
			this.consumed = true;
		}
	}

	valid(height: number): boolean {
		return this.row < height;
	}
}

/** PHP round(): half away from zero, unlike Math.round's half toward +Infinity. */
export function phpRound(value: number): number {
	return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function drawTexturedTriangle(
	p1in: RasterPoint,
	p2in: RasterPoint,
	p3in: RasterPoint,
	buffer: FaceBuffer,
	texture: FloatTexture,
	cursor: RowCursor = new RowCursor(),
): void {
	const { width, height } = buffer;
	// Stable sort by y ascending (PHP usort is stable since 8.0).
	const points = [p1in, p2in, p3in].toSorted((a, b) => a.y - b.y);
	const [p1, p2, p3] = points;

	let diff1x = p2.x - p1.x;
	let diff1y = p2.y - p1.y;
	let uvDiff1u = p2.u - p1.u;
	let uvDiff1v = p2.v - p1.v;
	let depthDiff1 = p2.depth - p1.depth;

	const diff2x = p3.x - p1.x;
	const diff2y = p3.y - p1.y;
	const uvDiff2u = p3.u - p1.u;
	const uvDiff2v = p3.v - p1.v;
	const depthDiff2 = p3.depth - p1.depth;

	let xyStep1 = diff1y ? diff1x / diff1y : 0;
	const xyStep2 = diff2y ? diff2x / diff2y : 0;
	let uvStep1u = diff1y ? uvDiff1u / Math.abs(diff1y) : 0;
	let uvStep1v = diff1y ? uvDiff1v / Math.abs(diff1y) : 0;
	const uvStep2u = diff2y ? uvDiff2u / Math.abs(diff2y) : 0;
	const uvStep2v = diff2y ? uvDiff2v / Math.abs(diff2y) : 0;
	let depthStep1 = diff1y ? depthDiff1 / Math.abs(diff1y) : 0;
	const depthStep2 = diff2y ? depthDiff2 / Math.abs(diff2y) : 0;

	let startPoint = p1;
	let endPoint = p2;

	for (let part = 0; part < 2; part++) {
		if (diff1y > 0) {
			const startY = startPoint.y;
			const endY = endPoint.y;
			cursor.moveTo(startY);
			for (let y = startY; y <= endY; y++) {
				if (y < 0) {
					continue;
				}
				if (!cursor.valid(height)) {
					break;
				}
				// The row actually written can trail y by one — see RowCursor.
				const row = cursor.current();

				let startX = phpRound(startPoint.x + (y - startPoint.y) * xyStep1);
				let endX = phpRound(p1.x + (y - p1.y) * xyStep2);

				let startU = startPoint.u + (y - startPoint.y) * uvStep1u;
				let startV = startPoint.v + (y - startPoint.y) * uvStep1v;
				let startDepth = startPoint.depth + (y - startPoint.y) * depthStep1;

				let endU = p1.u + (y - p1.y) * uvStep2u;
				let endV = p1.v + (y - p1.y) * uvStep2v;
				let endDepth = p1.depth + (y - p1.y) * depthStep2;

				if (startX > endX) {
					[startX, endX] = [endX, startX];
					[startU, endU] = [endU, startU];
					[startV, endV] = [endV, startV];
					[startDepth, endDepth] = [endDepth, startDepth];
				}

				const lineLength = endX - startX;
				const textureStep = lineLength ? 1 / lineLength : 0;
				// Slightly move into the first step to prevent seams (upstream constant).
				let textureX = textureStep * 0.3;

				const rowOffset = row * width;
				for (let x = startX - 1; x <= endX + 1; x++) {
					const currentU = (1 - textureX) * startU + textureX * endU;
					const currentV = (1 - textureX) * startV + textureX * endV;
					const currentDepth = (1 - textureX) * startDepth + textureX * endDepth;

					if (x >= 0 && x < width) {
						// Nearest by truncation, clamped to the texture (Imagick virtual pixels
						// clamp to edge for the fractionally-out-of-range coords the bias allows).
						let texX = Math.trunc(currentU * texture.width);
						let texY = Math.trunc(currentV * texture.height);
						texX = texX < 0 ? 0 : (texX >= texture.width ? texture.width - 1 : texX);
						texY = texY < 0 ? 0 : (texY >= texture.height ? texture.height - 1 : texY);
						const src = (texY * texture.width + texX) * 4;
						const dst = (rowOffset + x) * 4;
						buffer.colors[dst] = texture.data[src];
						buffer.colors[dst + 1] = texture.data[src + 1];
						buffer.colors[dst + 2] = texture.data[src + 2];
						buffer.colors[dst + 3] = texture.data[src + 3];
					}

					if (x >= startX && x < endX && x >= 0 && x < width) {
						// Depth lives in a Q16 Imagick channel upstream: quantized and clamped.
						// Matching that makes coplanar/edge depths tie exactly, so the stable
						// face order resolves them the same way.
						const clamped = currentDepth < 0 ? 0 : (Math.min(currentDepth, 1));
						buffer.depths[rowOffset + x] = Math.round(clamped * 65535) / 65535;
						// textureX only advances inside this branch (upstream behavior): the
						// leading overdraw pixel reuses the 0.3 bias, trailing ones the final value.
						textureX += textureStep;
					}
				}
				cursor.next();
			}
		}

		diff1x = p3.x - p2.x;
		diff1y = p3.y - p2.y;
		uvDiff1u = p3.u - p2.u;
		uvDiff1v = p3.v - p2.v;
		depthDiff1 = p3.depth - p2.depth;

		xyStep1 = diff1y ? diff1x / diff1y : 0;
		uvStep1u = diff1y ? uvDiff1u / Math.abs(diff1y) : 0;
		uvStep1v = diff1y ? uvDiff1v / Math.abs(diff1y) : 0;
		depthStep1 = diff1y ? depthDiff1 / Math.abs(diff1y) : 0;

		startPoint = p2;
		endPoint = p3;
	}
}
