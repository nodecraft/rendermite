/**
 * Turning a set of texture ids into a stitched atlas plus the JSON that
 * addresses it, which is the same problem whether the sprites came from block
 * models or from item models.
 *
 * Extracted from `export.ts` when the item sprites arrived, unchanged: the
 * fiddly parts — an animation strip becoming one rect per physical frame, a
 * `.mcmeta` claiming more frames than an atlas can hold, a sprite too large for
 * a page, alpha deciding the render layer — are all things it would be a mistake
 * to write twice and let drift.
 *
 * Nothing here knows what names the sprites. Callers that need a guaranteed
 * fallback sprite pass `includeMissing`; callers that do not (an item sheet, where
 * a missing sprite means the consumer draws a box instead) leave it off.
 */

import { packAtlas } from './atlas-pack.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { PackedPage } from './atlas-pack.ts';
import type { BlockPackRenderLayer, BlockPackSprite, BlockPackSpriteFrame } from './pack-format.ts';
import type { Texture, TextureLoader } from '../textures/loader.ts';

/**
 * Vanilla's own id for the missing-texture sprite. A face whose texture does
 * not resolve is drawn by the game in black and magenta rather than skipped —
 * Blockbench leaves `"texture": "#missing"` on unassigned faces and mods ship
 * models naming textures they forgot to include. Dropping those faces would
 * put holes in geometry the player can see, and would read as our bug rather
 * than the mod's.
 */
export const MISSING_SPRITE = 'minecraft:missingno';

/**
 * A sprite whose strip is longer than this exports as its first frame only.
 * A broken `.mcmeta` can claim thousands of frames, and packing them would
 * blow the atlas out for one texture.
 */
const MAX_FRAMES_PER_SPRITE = 256;

/** `MissingTextureAtlasSprite`: 16x16, black and magenta in 8px quarters. */
export function missingTexture(): Texture {
	const size = 16;
	const data = new Uint8ClampedArray(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const magenta = (x < 8) !== (y < 8);
			const offset = (y * size + x) * 4;
			data[offset] = magenta ? 248 : 0;
			data[offset + 1] = 0;
			data[offset + 2] = magenta ? 248 : 0;
			data[offset + 3] = 255;
		}
	}
	return { width: size, height: size, data };
}

/**
 * Alpha decides the render layer: vanilla assets do not state cutout versus
 * translucent (`render_type` is a loader extension adopted only recently), and
 * inferring it covers mods for free.
 */
export function inferRenderLayer(frames: Texture[]): BlockPackRenderLayer {
	let sawHole = false;
	for (const frame of frames) {
		for (let offset = 3; offset < frame.data.length; offset += 4) {
			const alpha = frame.data[offset];
			if (alpha === 0) {
				sawHole = true;
			} else if (alpha !== 255) {
				return 'translucent';
			}
		}
	}
	return sawHole ? 'cutout' : 'solid';
}

export interface SpriteSheetFailure {
	id: string;
	reason: string;
}

export interface BuildSpriteSheetOptions {
	/** Edge-extended border per sprite side (default 4). */
	padding?: number;
	/** Ceiling on a page's dimensions (default 4096). */
	maxPageSize?: number;
	/**
	 * Pack the black-and-magenta missing-texture sprite whether or not anything
	 * named it, and throw if it does not fit. What a consumer draws for something
	 * this pack does not describe at all; a guarantee worth its 256 pixels.
	 */
	includeMissing?: boolean;
	onProgress?: (done: number, total: number) => void;
}

export interface SpriteSheet {
	pages: PackedPage[];
	/** Ready for `atlas.json`, unsorted — the caller decides the key order. */
	sprites: Record<string, BlockPackSprite>;
	/**
	 * Ids that never loaded or never fit a page, so have no rect. A caller must
	 * not emit anything naming one of these; the block path rewrites those
	 * references to `MISSING_SPRITE`, and the item path drops the item.
	 */
	missing: Set<string>;
	failures: SpriteSheetFailure[];
	padding: number;
}

interface LoadedSprite {
	id: string;
	/** Physical frame index → pixels. */
	frames: Map<number, Texture>;
	sequence: Array<{ frame: number; time: number; }>;
	interpolate: boolean;
}

/**
 * Loads every id, packs the frames, and returns the sheet plus everything that
 * did not make it. Ids are packed in sorted order so an unchanged input produces
 * a byte-identical atlas.
 */
export async function buildSpriteSheet(
	ids: Iterable<string>,
	textures: TextureLoader,
	options: BuildSpriteSheetOptions = {},
): Promise<SpriteSheet> {
	const wanted = new Set(ids);
	if (options.includeMissing) {
		// Synthesized below rather than loaded; no jar ships it
		wanted.delete(MISSING_SPRITE);
	}
	const failures: SpriteSheetFailure[] = [];
	const missing = new Set<string>();
	const loaded: LoadedSprite[] = [];
	let done = 0;
	for (const id of [...wanted].toSorted((left, right) => left.localeCompare(right))) {
		options.onProgress?.(++done, wanted.size);
		let animated;
		try {
			animated = await textures.loadAnimated(ResourceLocator.parse(id));
		} catch (err) {
			failures.push({ id, reason: (err as Error).message });
			missing.add(id);
			continue;
		}
		if (!animated) {
			failures.push({ id, reason: 'texture not found' });
			missing.add(id);
			continue;
		}
		const overlong = animated.frameCount > MAX_FRAMES_PER_SPRITE;
		if (overlong) {
			failures.push({
				id,
				reason: `${animated.frameCount} frames exceeds the ${MAX_FRAMES_PER_SPRITE} cap; exported static`,
			});
		}
		const starts = overlong ? [0] : animated.frameStartTicks();
		const total = overlong ? 1 : animated.tickLength;
		const sequence = starts.map((start, index) => {
			return {
				frame: animated.resolveFrame(start).frame,
				time: (index + 1 < starts.length ? starts[index + 1] : total) - start,
			};
		});
		const frames = new Map<number, Texture>();
		for (const entry of sequence) {
			if (!frames.has(entry.frame)) {
				frames.set(entry.frame, animated.frame(entry.frame));
			}
		}
		loaded.push({ id, frames, sequence, interpolate: animated.interpolated });
	}

	if (options.includeMissing) {
		loaded.push({
			id: MISSING_SPRITE,
			frames: new Map([[0, missingTexture()]]),
			sequence: [{ frame: 0, time: 1 }],
			interpolate: false,
		});
	}

	const packed = packAtlas(
		loaded.flatMap(sprite => [...sprite.frames].map(([index, texture]) => {
			return { key: `${sprite.id}#${index}`, texture };
		})),
		{ padding: options.padding, maxPageSize: options.maxPageSize },
	);
	for (const key of packed.oversized) {
		const id = key.split('#', 1)[0];
		// Every frame of an animated sprite is the same size, so report once
		if (!missing.has(id)) {
			failures.push({ id, reason: 'sprite is larger than one atlas page; drawn as the missing texture' });
			missing.add(id);
		}
	}
	if (options.includeMissing && missing.has(MISSING_SPRITE)) {
		throw new Error('the missing-texture sprite does not fit an atlas page; maxPageSize is too small');
	}

	const rects = new Map(packed.rects.map(rect => [rect.key, rect]));
	const sprites: Record<string, BlockPackSprite> = {};
	for (const sprite of loaded) {
		const first = rects.get(`${sprite.id}#${sprite.sequence[0].frame}`);
		if (!first) {
			continue;
		}
		const frames: BlockPackSpriteFrame[] = [];
		for (const entry of sprite.sequence) {
			const rect = rects.get(`${sprite.id}#${entry.frame}`);
			if (rect) {
				frames.push({ page: rect.page, x: rect.x, y: rect.y, time: entry.time });
			}
		}
		sprites[sprite.id] = {
			page: first.page,
			x: first.x,
			y: first.y,
			w: first.width,
			h: first.height,
			layer: inferRenderLayer(sprite.frames.values().toArray()),
			...(frames.length === sprite.sequence.length && frames.length > 1 && { frames }),
			...(sprite.interpolate && { interpolate: true as const }),
		};
	}

	return { pages: packed.pages, sprites, missing, failures, padding: packed.padding };
}
