/**
 * Icon encoding via sharp. Defaults are tuned so no separate optimization step
 * is needed: lossless everywhere, strictly-smaller candidates only.
 */

import sharp from 'sharp';

import { toByteTexture } from '../render/blend.ts';

import type { FloatTexture } from '../render/blend.ts';
import type { Sharp } from 'sharp';

export interface EncodedIcon {
	png: Buffer;
	webp?: Buffer;
	avif?: Buffer;
}

export interface EncodeOptions {
	webp?: boolean;
	/** Off by default: measure size/time before enabling — 64px icons rarely benefit. */
	avif?: boolean;
}

export interface EncodedAnimatedIcon extends EncodedIcon {
	/** GIF for legacy browsers, only produced for animated icons. */
	gif?: Buffer;
	/** Whether the avif buffer carries the animation or fell back to frame 0. */
	avifAnimated?: boolean;
}

export interface AnimatedEncodeOptions extends EncodeOptions {
	gif?: boolean;
}

export type RasterAssetFormat = 'png' | 'webp' | 'avif';

/**
 * Lossless WebP effort for single-frame icons. Measured across 1.12.2–1.21.8
 * vanilla, effort 2 is 0.1–1.9% SMALLER than effort 6 for static icons at 2.8×
 * the speed — libvips' higher efforts search predictors that rarely pay off on
 * 64px sprites. Animations are the opposite (up to 21% larger on one item), so
 * they keep effort 6 below.
 */
const STATIC_WEBP_EFFORT = 2;
const ANIMATED_WEBP_EFFORT = 6;

/** Frames encoded concurrently when assembling an animation's pages. */
const PAGE_ENCODE_BATCH = 8;

/** Losslessly transcode an existing PNG resource into the formats referenced by generated CSS. */
export async function encodeRasterAsset(source: Buffer, formats: readonly RasterAssetFormat[]): Promise<Map<RasterAssetFormat, Buffer>> {
	const image = sharp(source);
	const unique = [...new Set(formats)];
	const encoded = await Promise.all(unique.map(async (format): Promise<[RasterAssetFormat, Buffer]> => {
		switch (format) {
			case 'png': {
				return [format, await image.clone().png({ compressionLevel: 9, effort: 10 }).toBuffer()];
			}
			case 'webp': {
				return [format, await image.clone().webp({ lossless: true, effort: 6 }).toBuffer()];
			}
			case 'avif': {
				return [format, await image.clone().avif({ lossless: true, effort: 6 }).toBuffer()];
			}
		}
	}));
	return new Map(encoded);
}

/**
 * Encode a multi-frame icon: animated WebP (universal), optional GIF for
 * legacy browsers, PNG as the static first frame (matching upstream's
 * fallback), and AVIF animated where the local libvips supports it —
 * otherwise a static first frame.
 */
export async function encodeAnimatedIcon(
	frames: FloatTexture[],
	delaysMs: number[],
	options: AnimatedEncodeOptions = {},
): Promise<EncodedAnimatedIcon> {
	if (frames.length === 1) {
		return encodeIcon(frames[0], options);
	}
	const { width, height } = frames[0];
	// libvips assembles animations from an array of encoded pages; raw
	// multi-page buffers don't carry the page metadata through. Fast PNGs
	// (no compression) are only intermediates here.
	// Bounded rather than a Promise.all over every frame: a 128-frame icon in
	// each of several render threads would otherwise put a thousand concurrent
	// encodes on libvips at once.
	const pages: Buffer[] = [];
	for (let start = 0; start < frames.length; start += PAGE_ENCODE_BATCH) {
		pages.push(...await Promise.all(frames.slice(start, start + PAGE_ENCODE_BATCH).map((frame) => {
			const bytes = toByteTexture(frame);
			return sharp(Buffer.from(bytes.data.buffer, bytes.data.byteOffset, bytes.data.length), {
				raw: { width, height, channels: 4 },
			}).png({ compressionLevel: 0 }).toBuffer();
		})));
	}
	const animated = () => sharp(pages, { join: { animated: true } });

	// PNG fallback and animated WebP are independent native encodes — overlap
	// them so the single-frame PNG (usually the smaller job) runs alongside.
	const webpPromise = options.webp !== false
		? animated().webp({ lossless: true, effort: ANIMATED_WEBP_EFFORT, loop: 0, delay: delaysMs }).toBuffer()
		: Promise.resolve(undefined);
	const firstFramePromise = encodeIcon(frames[0], { webp: false });
	const gifPromise = options.gif
		? animated().gif({ loop: 0, delay: delaysMs }).toBuffer()
		: Promise.resolve(undefined);

	const [firstFrame, webp, gif] = await Promise.all([firstFramePromise, webpPromise, gifPromise]);
	const result: EncodedAnimatedIcon = { png: firstFrame.png };
	if (webp) {
		result.webp = webp;
	}
	if (gif) {
		result.gif = gif;
	}
	if (options.avif) {
		// libheif builds bundled with sharp generally cannot encode image
		// sequences; fall back to a static first frame rather than failing.
		try {
			result.avif = await animated().avif({ lossless: true, effort: 6 }).toBuffer();
			result.avifAnimated = true;
		} catch {
			const staticAvif = await encodeIcon(frames[0], { webp: false, avif: true });
			result.avif = staticAvif.avif;
			result.avifAnimated = false;
		}
	}
	return result;
}

/** Distinct RGBA colors, up to a cap (palette PNGs hold at most 256). */
function countColors(data: Uint8ClampedArray, cap: number): number {
	const seen = new Set<number>();
	for (let offset = 0; offset < data.length; offset += 4) {
		seen.add(((data[offset] * 256 + data[offset + 1]) * 256 + data[offset + 2]) * 256 + data[offset + 3]);
		if (seen.size > cap) {
			return seen.size;
		}
	}
	return seen.size;
}

export async function encodeIcon(texture: FloatTexture, options: EncodeOptions = {}): Promise<EncodedIcon> {
	const bytes = toByteTexture(texture);
	const pixels = Buffer.from(bytes.data.buffer, bytes.data.byteOffset, bytes.data.length);
	// A fresh pipeline per format rather than clone(), which structured-clones its options and the
	// pixel buffer with them; nothing is applied before the encoders diverge, so the two are the same.
	const raw = (): Sharp => sharp(pixels, { raw: { width: bytes.width, height: bytes.height, channels: 4 } });

	// Palette PNGs are smaller but sharp's quantizer silently degrades icons
	// with more than 256 colors (this is exactly how the old pipeline shipped
	// quantized wood-block icons) — only use it when it is provably lossless.
	const paletteSafe = countColors(bytes.data, 256) <= 256;

	// Encode PNG and WebP in parallel: they are independent native operations
	// that run on libvips' threadpool, so overlapping them roughly halves the
	// wall time for the common single-frame icon.
	const pngPromise = raw().png({ compressionLevel: 9, effort: 10, palette: paletteSafe }).toBuffer();
	const webpPromise = options.webp !== false
		? raw().webp({ lossless: true, effort: STATIC_WEBP_EFFORT }).toBuffer()
		: Promise.resolve(undefined);
	const avifPromise = options.avif
		? raw().avif({ lossless: true, effort: 6 }).toBuffer()
		: Promise.resolve(undefined);
	const [png, webp, avif] = await Promise.all([pngPromise, webpPromise, avifPromise]);
	const result: EncodedIcon = { png };
	if (webp) {
		result.webp = webp;
	}
	if (avif) {
		result.avif = avif;
	}
	return result;
}
