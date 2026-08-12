/**
 * Color math mirroring renderchest's ColorBlender exactly. All values are
 * normalized floats in [0,1], straight (non-premultiplied) alpha, sRGB space —
 * upstream does no linearization and neither do we.
 */

import type { Texture } from '../textures/loader.ts';

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
	for (let i = 0; i < texture.data.length; i++) {
		// ImageMagick's PNG write path maps Q16 → 8-bit as floor(quantum / 257)
		// (probed exhaustively; float q*255/65535 misrounds at exact multiples).
		const value = texture.data[i];
		const clamped = value < 0 ? 0 : (Math.min(value, 1));
		data[i] = Math.floor(Math.round(clamped * 65535) / 257);
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
 * Results are Q16-quantized like every Imagick pixel write.
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
	dst[offset] = q16((sr * sa + dst[offset] * dstWeight) / ra);
	dst[offset + 1] = q16((sg * sa + dst[offset + 1] * dstWeight) / ra);
	dst[offset + 2] = q16((sb * sa + dst[offset + 2] * dstWeight) / ra);
	dst[offset + 3] = q16(ra);
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
 * Upstream darkenTexture: blend pure black with alpha = amount * pixel.alpha,
 * restricted to the UV bounding box expanded by 1px on each side.
 */
export function darkenTexture(texture: FloatTexture, amount: number, u1: number, v1: number, u2: number, v2: number): void {
	let startX = Math.floor(Math.min(u1, u2));
	let endX = Math.ceil(Math.max(u1, u2));
	let startY = Math.floor(Math.min(v1, v2));
	let endY = Math.ceil(Math.max(v1, v2));
	startX = Math.max(0, startX - 1);
	startY = Math.max(0, startY - 1);
	endX = Math.min(texture.width - 1, endX + 1);
	endY = Math.min(texture.height - 1, endY + 1);
	const { data } = texture;
	for (let y = startY; y <= endY; y++) {
		for (let x = startX; x <= endX; x++) {
			const offset = (y * texture.width + x) * 4;
			blendPixel(data, offset, 0, 0, 0, amount * data[offset + 3]);
		}
	}
}
