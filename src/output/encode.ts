/**
 * Icon encoding via sharp. Defaults reproduce the ui pipeline's post-pass so no
 * separate optimization step is needed: lossless everywhere, strictly-smaller
 * candidates only.
 */

import sharp from 'sharp';

import { toByteTexture } from '../render/blend.ts';

import type { FloatTexture } from '../render/blend.ts';

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
	const pages = await Promise.all(frames.map((frame) => {
		const bytes = toByteTexture(frame);
		return sharp(Buffer.from(bytes.data.buffer, bytes.data.byteOffset, bytes.data.length), {
			raw: { width, height, channels: 4 },
		}).png({ compressionLevel: 0 }).toBuffer();
	}));
	const animated = () => sharp(pages, { join: { animated: true } });

	// PNG fallback stays single-frame, like upstream's --fallback output.
	const firstFrame = await encodeIcon(frames[0], { webp: false });
	const result: EncodedAnimatedIcon = { png: firstFrame.png };
	if (options.webp !== false) {
		result.webp = await animated().webp({ lossless: true, effort: 6, loop: 0, delay: delaysMs }).toBuffer();
	}
	if (options.gif) {
		result.gif = await animated().gif({ loop: 0, delay: delaysMs }).toBuffer();
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
	const raw = sharp(Buffer.from(bytes.data.buffer, bytes.data.byteOffset, bytes.data.length), {
		raw: { width: bytes.width, height: bytes.height, channels: 4 },
	});

	// Palette PNGs are smaller but sharp's quantizer silently degrades icons
	// with more than 256 colors (this is exactly how the old pipeline shipped
	// quantized wood-block icons) — only use it when it is provably lossless.
	const paletteSafe = countColors(bytes.data, 256) <= 256;
	const png = await raw.clone().png({ compressionLevel: 9, effort: 10, palette: paletteSafe }).toBuffer();
	const result: EncodedIcon = { png };

	if (options.webp !== false) {
		result.webp = await raw.clone().webp({ lossless: true, effort: 6 }).toBuffer();
	}
	if (options.avif) {
		result.avif = await raw.clone().avif({ lossless: true, effort: 6 }).toBuffer();
	}
	return result;
}
