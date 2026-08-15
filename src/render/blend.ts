/**
 * Color math mirroring renderchest's ColorBlender exactly. All values are
 * normalized floats in [0,1], straight (non-premultiplied) alpha, sRGB space —
 * upstream does no linearization and neither do we.
 */

import type { Texture } from '../textures/loader.ts';

/** Lookup table for Q16 → 8-bit conversion (ImageMagick's floor(q/257)). */
const BYTE_LUT = new Uint8Array(65536);

/** RGBA float pixels for render-time work; converted back to 8-bit at encode. */
export interface FloatTexture {
	width: number;
	height: number;
	/** RGBA, row-major, normalized [0,1]. */
	data: Float64Array;
}

export function toFloatTexture(texture: Texture): FloatTexture {
	const data = new Float64Array(texture.data.length);
	for (let i = 0; i < texture.data.length; i++) {
		data[i] = texture.data[i] / 255;
	}
	return { width: texture.width, height: texture.height, data };
}

export function toByteTexture(texture: FloatTexture): Texture {
	const data = new Uint8ClampedArray(texture.data.length);
	// ImageMagick's PNG write path maps Q16 → 8-bit as floor(quantum / 257)
	// (probed exhaustively; float q*255/65535 misrounds at exact multiples).
	// Precompute a 65536-entry lookup table so the conversion is an array index
	// instead of two Math calls per channel per pixel.
	if (BYTE_LUT[65535] === 0) {
		for (let q = 0; q < 65536; q++) {
			BYTE_LUT[q] = Math.floor(q / 257);
		}
	}
	const src = texture.data;
	// eslint-disable-next-line unicorn/no-for-loop -- hot path: .entries() allocates per element
	for (let i = 0; i < src.length; i++) {
		const value = src[i];
		// eslint-disable-next-line unicorn/no-nested-ternary, unicorn/prefer-math-min-max -- hot path: ternary is faster than Math.min
		const clamped = value < 0 ? 0 : value > 1 ? 1 : value;
		data[i] = BYTE_LUT[Math.round(clamped * 65535)];
	}
	return { width: texture.width, height: texture.height, data };
}

export function cloneFloatTexture(texture: FloatTexture): FloatTexture {
	return { width: texture.width, height: texture.height, data: new Float64Array(texture.data) };
}

/**
 * Imagick stores every pixel write as a Q16 quantum; values re-read for the
 * next operation carry that quantization. Matching it is what turns
 * off-by-one downscale rounding into exact parity.
 */
export function q16(value: number): number {
	const clamped = value < 0 ? 0 : (Math.min(value, 1));
	return Math.round(clamped * 65535) / 65535;
}

/**
 * Source-over with straight alpha, in place on `dst` at `offset`:
 * ra = 1-(1-sa)(1-da); rc = (sc*sa + dc*da*(1-sa)) / ra; rgb = 0 when ra = 0.
 * Results are Q16-quantized like every Imagick pixel write. q16 is inlined
 * here because blendPixel is the single hottest function in the pipeline.
 */
export function blendPixel(dst: Float64Array, offset: number, sr: number, sg: number, sb: number, sa: number): void {
	const da = dst[offset + 3];
	const ra = 1 - (1 - sa) * (1 - da);
	if (ra === 0) {
		dst[offset] = 0;
		dst[offset + 1] = 0;
		dst[offset + 2] = 0;
		dst[offset + 3] = 0;
		return;
	}
	const dstWeight = da * (1 - sa);
	let v = (sr * sa + dst[offset] * dstWeight) / ra;
	// eslint-disable-next-line unicorn/no-nested-ternary, unicorn/prefer-math-min-max -- hot path: ternary avoids Math.min call overhead
	v = v < 0 ? 0 : v > 1 ? 1 : v;
	dst[offset] = Math.round(v * 65535) / 65535;
	v = (sg * sa + dst[offset + 1] * dstWeight) / ra;
	// eslint-disable-next-line unicorn/no-nested-ternary, unicorn/prefer-math-min-max
	v = v < 0 ? 0 : v > 1 ? 1 : v;
	dst[offset + 1] = Math.round(v * 65535) / 65535;
	v = (sb * sa + dst[offset + 2] * dstWeight) / ra;
	// eslint-disable-next-line unicorn/no-nested-ternary, unicorn/prefer-math-min-max
	v = v < 0 ? 0 : v > 1 ? 1 : v;
	dst[offset + 2] = Math.round(v * 65535) / 65535;
	// eslint-disable-next-line unicorn/no-nested-ternary, unicorn/prefer-math-min-max
	v = ra < 0 ? 0 : ra > 1 ? 1 : ra;
	dst[offset + 3] = Math.round(v * 65535) / 65535;
}

/**
 * Upstream tintImage: uses ONLY the red channel as luminance — per pixel,
 * source-over blend of {tint.rgb * pixel.r, alpha: pixel.a} onto the pixel.
 */
export function tintTexture(texture: FloatTexture, tintR: number, tintG: number, tintB: number): void {
	const { data } = texture;
	for (let offset = 0; offset < data.length; offset += 4) {
		const value = data[offset];
		blendPixel(data, offset, tintR * value, tintG * value, tintB * value, data[offset + 3]);
	}
}

/**
 * Scale the alpha channel by a constant, over the same 1px-expanded UV window
 * darkenTexture uses. Straight alpha, so colour is left alone.
 */
export function scaleTextureAlpha(texture: FloatTexture, factor: number, u1: number, v1: number, u2: number, v2: number): void {
	const { data } = texture;
	forEachUvPixel(texture, u1, v1, u2, v2, (offset) => {
		data[offset + 3] = q16(data[offset + 3] * factor);
	});
}

/**
 * Upstream darkenTexture: blend pure black with alpha = amount * pixel.alpha,
 * restricted to the UV bounding box expanded by 1px on each side.
 */
export function darkenTexture(texture: FloatTexture, amount: number, u1: number, v1: number, u2: number, v2: number): void {
	const { data } = texture;
	forEachUvPixel(texture, u1, v1, u2, v2, (offset) => {
		blendPixel(data, offset, 0, 0, 0, amount * data[offset + 3]);
	});
}

/** The UV bounding box expanded by 1px on each side, clamped to the texture. */
function forEachUvPixel(
	texture: FloatTexture,
	u1: number,
	v1: number,
	u2: number,
	v2: number,
	visit: (offset: number) => void,
): void {
	const startX = Math.max(0, Math.floor(Math.min(u1, u2)) - 1);
	const startY = Math.max(0, Math.floor(Math.min(v1, v2)) - 1);
	const endX = Math.min(texture.width - 1, Math.ceil(Math.max(u1, u2)) + 1);
	const endY = Math.min(texture.height - 1, Math.ceil(Math.max(v1, v2)) + 1);
	for (let y = startY; y <= endY; y++) {
		for (let x = startX; x <= endX; x++) {
			visit((y * texture.width + x) * 4);
		}
	}
}

/**
 * The per-face shading a sample applies as it is written, instead of against a
 * pre-shaded copy of the texture.
 *
 * Shading used to clone the whole texture per face and darken its UV window.
 * That is fine for block models, whose faces reuse a handful of windows, and
 * catastrophic for anything detailed: a 1,208-cube GeckoLib gun has 6,136 faces,
 * each with its own UV rect and its own float light level, so nothing is ever
 * reused — 6,136 clones of a 1024x1024 texture, over 20 GB for one 16x16 icon.
 * Cost now tracks pixels actually drawn (a few hundred) rather than the atlas.
 */
export interface FaceShading {
	tint: { r: number; g: number; b: number; } | null;
	/** Blend-to-black amount, applied only inside the window. */
	darkness: number;
	/** Alpha multiplier, applied only inside the window. */
	alpha: number;
	/** UV bounding box in texels, expanded 1px each way, clamped — see uvWindow. */
	windowX1: number;
	windowY1: number;
	windowX2: number;
	windowY2: number;
}

/** The UV window darkenTexture would have covered, in texels. */
export function uvWindow(
	texture: FloatTexture,
	u1: number,
	v1: number,
	u2: number,
	v2: number,
): [number, number, number, number] {
	return [
		Math.max(0, Math.floor(Math.min(u1, u2)) - 1),
		Math.max(0, Math.floor(Math.min(v1, v2)) - 1),
		Math.min(texture.width - 1, Math.ceil(Math.max(u1, u2)) + 1),
		Math.min(texture.height - 1, Math.ceil(Math.max(v1, v2)) + 1),
	];
}

/**
 * Source-over of one colour onto one pixel, written into `dst`. The same
 * arithmetic as blendPixel, reading its source from separate values so a sample
 * can be shaded without a backing array.
 */
function blendInto(dst: Float64Array, at: number, red: number, green: number, blue: number, alpha: number, sr: number, sg: number, sb: number, sa: number): void {
	const ra = 1 - (1 - sa) * (1 - alpha);
	if (ra === 0) {
		dst[at] = 0;
		dst[at + 1] = 0;
		dst[at + 2] = 0;
		dst[at + 3] = 0;
		return;
	}
	const dstWeight = alpha * (1 - sa);
	dst[at] = q16((sr * sa + red * dstWeight) / ra);
	dst[at + 1] = q16((sg * sa + green * dstWeight) / ra);
	dst[at + 2] = q16((sb * sa + blue * dstWeight) / ra);
	dst[at + 3] = q16(ra);
}

/**
 * Copy one texel into a face buffer with the face's shading applied, matching
 * tintTexture → darkenTexture → scaleTextureAlpha run over a cloned texture.
 * Tint covers the whole sheet; darkness and alpha only the UV window, which is
 * why a sample landing outside it (the rasterizer overdraws by a pixel) must
 * stay untouched by those two.
 */
export function shadeTexel(
	dst: Float64Array,
	at: number,
	source: Float64Array,
	from: number,
	shading: FaceShading,
	texX: number,
	texY: number,
): void {
	const red = source[from];
	const green = source[from + 1];
	const blue = source[from + 2];
	const alpha = source[from + 3];

	const inWindow = texX >= shading.windowX1 && texX <= shading.windowX2
		&& texY >= shading.windowY1 && texY <= shading.windowY2;
	const { tint } = shading;

	// Overwhelmingly the common case: an untinted, fully opaque texel. Blending
	// black at `darkness` over alpha 1 reduces to scaling the colour by its
	// complement, which is one multiply instead of a source-over per channel.
	if (tint === null && alpha === 1) {
		if (!inWindow) {
			dst[at] = red;
			dst[at + 1] = green;
			dst[at + 2] = blue;
			dst[at + 3] = 1;
			return;
		}
		const keep = 1 - shading.darkness;
		dst[at] = q16(red * keep);
		dst[at + 1] = q16(green * keep);
		dst[at + 2] = q16(blue * keep);
		dst[at + 3] = shading.alpha < 1 ? q16(shading.alpha) : 1;
		return;
	}

	// Fully transparent texels darken to nothing: blendPixel's ra is 0.
	if (tint === null && alpha === 0 && inWindow) {
		dst[at] = 0;
		dst[at + 1] = 0;
		dst[at + 2] = 0;
		dst[at + 3] = 0;
		return;
	}

	let currentRed = red;
	let currentGreen = green;
	let currentBlue = blue;
	let currentAlpha = alpha;
	if (tint) {
		// Upstream tints from the RED channel only, treating it as luminance.
		blendInto(dst, at, currentRed, currentGreen, currentBlue, currentAlpha, tint.r * red, tint.g * red, tint.b * red, currentAlpha);
		currentRed = dst[at];
		currentGreen = dst[at + 1];
		currentBlue = dst[at + 2];
		currentAlpha = dst[at + 3];
	}
	if (inWindow) {
		blendInto(dst, at, currentRed, currentGreen, currentBlue, currentAlpha, 0, 0, 0, shading.darkness * currentAlpha);
		currentRed = dst[at];
		currentGreen = dst[at + 1];
		currentBlue = dst[at + 2];
		currentAlpha = shading.alpha < 1 ? q16(dst[at + 3] * shading.alpha) : dst[at + 3];
	}

	dst[at] = currentRed;
	dst[at + 1] = currentGreen;
	dst[at + 2] = currentBlue;
	dst[at + 3] = currentAlpha;
}
