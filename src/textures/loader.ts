import sharp from 'sharp';

import { LruCache } from '../resources/cache.ts';

import type { ResourceLocator } from '../resources/locator.ts';
import type { ResourceManager } from '../resources/manager.ts';

/** Structural interface for atlas resolvers (avoids a circular module edge). */
export interface AtlasResolverLike {
	resolve(locator: ResourceLocator): Promise<
		| { kind: 'file'; locator: ResourceLocator; }
		| { kind: 'pixels'; texture: Texture; }
		| null
	>;
}

/** Decoded texture pixels, always RGBA, 8-bit per channel. */
export interface Texture {
	width: number;
	height: number;
	/** RGBA, row-major, length = width * height * 4. */
	data: Uint8ClampedArray;
}

export interface TextureMeta {
	animation?: {
		frametime?: number;
		frames?: Array<number | { index: number; time?: number; }>;
		interpolate?: boolean;
		width?: number;
		height?: number;
	};
}

export class TextureResolutionError extends Error {}

/** Decoded-pixel budget and hard entry cap for one loader's texture cache. */
const MAX_TEXTURE_CACHE_BYTES = 128 * 1024 * 1024;
const MAX_TEXTURE_CACHE_ENTRIES = 8192;

/**
 * Animation-aware texture access: frame extraction over strips and grids with
 * mcmeta frame lists, per-frame times, and interpolation (upstream semantics:
 * cols = trunc(16/meta.width), frame count from geometry when no list).
 */
export class AnimatedTexture {
	private readonly full: Texture;
	private readonly meta: TextureMeta | null;
	private readonly columns: number;
	private readonly frameCache = new Map<number, Texture>();
	readonly frameWidth: number;
	readonly frameHeight: number;
	readonly frameCount: number;

	constructor(full: Texture, meta: TextureMeta | null) {
		this.full = full;
		this.meta = meta;
		const metaWidth = meta?.animation?.width ?? 16;
		const metaHeight = meta?.animation?.height ?? 16;
		this.columns = Math.max(1, Math.trunc(16 / metaWidth));
		this.frameWidth = Math.round(full.width * (metaWidth / 16));
		this.frameHeight = Math.round(this.frameWidth * (metaHeight / 16));
		const frames = meta?.animation?.frames;
		if (!meta?.animation) {
			this.frameCount = 1;
		} else if (frames?.length) {
			this.frameCount = frames.length;
		} else {
			this.frameCount = Math.max(1, Math.round(full.height / this.frameHeight * this.columns));
		}
	}

	get interpolated(): boolean {
		return this.meta?.animation?.interpolate ?? false;
	}

	/** Total animation length in game ticks (1 for unanimated). */
	get tickLength(): number {
		if (!this.meta?.animation || this.frameCount <= 1) {
			return 1;
		}
		const frameTime = this.meta.animation.frametime ?? 1;
		const frames = this.meta.animation.frames;
		if (frames?.length) {
			let total = 0;
			for (const frame of frames) {
				total += typeof frame === 'number' ? frameTime : frame.time ?? frameTime;
			}
			return total;
		}
		return this.frameCount * frameTime;
	}

	/**
	 * Ticks within one cycle at which the displayed frame changes. Used to emit
	 * exactly the frames an animation actually has instead of walking every tick
	 * of a combined timeline that can run to tens of thousands.
	 */
	frameStartTicks(): number[] {
		const animation = this.meta?.animation;
		if (!animation || this.frameCount <= 1) {
			return [0];
		}
		const frameTime = animation.frametime ?? 1;
		const frames = animation.frames;
		if (!frames?.length) {
			return Array.from({ length: this.frameCount }, (_, index) => index * frameTime);
		}
		const starts: number[] = [];
		let tick = 0;
		for (const entry of frames) {
			starts.push(tick);
			tick += typeof entry === 'number' ? frameTime : entry.time ?? frameTime;
		}
		return starts;
	}

	/** Which physical frame index shows at a tick, and the interpolation factor. */
	resolveFrame(tick: number): { frame: number; interpolation: number; } {
		const animation = this.meta?.animation;
		if (!animation || this.frameCount <= 1) {
			return { frame: 0, interpolation: 0 };
		}
		const frameTime = animation.frametime ?? 1;
		const frames = animation.frames;
		if (!frames?.length) {
			return {
				frame: Math.floor(tick / frameTime) % this.frameCount,
				interpolation: (tick % frameTime) / frameTime,
			};
		}
		const total = this.tickLength;
		let remaining = tick % total;
		for (const entry of frames) {
			const index = typeof entry === 'number' ? entry : entry.index;
			const time = typeof entry === 'number' ? frameTime : entry.time ?? frameTime;
			if (remaining < time) {
				return { frame: index, interpolation: remaining / time };
			}
			remaining -= time;
		}
		return { frame: typeof frames[0] === 'number' ? frames[0] : frames[0].index, interpolation: 0 };
	}

	/** Crop one physical frame out of the strip/grid (memoized). */
	frame(index: number): Texture {
		let cached = this.frameCache.get(index);
		if (!cached) {
			const left = (index % this.columns) * this.frameWidth;
			const top = Math.floor(index / this.columns) * this.frameHeight;
			const data = new Uint8ClampedArray(this.frameWidth * this.frameHeight * 4);
			for (let y = 0; y < this.frameHeight; y++) {
				const sourceStart = ((top + y) * this.full.width + left) * 4;
				data.set(this.full.data.subarray(sourceStart, sourceStart + this.frameWidth * 4), y * this.frameWidth * 4);
			}
			cached = { width: this.frameWidth, height: this.frameHeight, data };
			this.frameCache.set(index, cached);
		}
		return cached;
	}

	/** The image shown at a tick: the frame, interpolated toward the next when enabled. */
	at(tick: number): Texture {
		const { frame, interpolation } = this.resolveFrame(tick);
		const base = this.frame(frame);
		if (!this.interpolated || interpolation === 0) {
			return base;
		}
		const next = this.frame((frame + 1) % this.frameCount);
		const data = new Uint8ClampedArray(base.data.length);
		for (let i = 0; i < data.length; i++) {
			data[i] = Math.round(base.data[i] + (next.data[i] - base.data[i]) * interpolation);
		}
		return { width: base.width, height: base.height, data };
	}
}

export class TextureLoader {
	private readonly resources: ResourceManager;
	private readonly cache: LruCache<string, Promise<Texture | null>>;
	private atlas: AtlasResolverLike | null = null;

	constructor(resources: ResourceManager, maxCacheBytes = MAX_TEXTURE_CACHE_BYTES) {
		this.resources = resources;
		// Bounded by decoded bytes rather than entry count: a namespace's sprites
		// are a kilobyte each, but one stitched atlas sheet can be megabytes.
		this.cache = new LruCache(MAX_TEXTURE_CACHE_ENTRIES, {
			maxWeight: maxCacheBytes,
			weigh: pending => (pending as Promise<Texture | null> & { bytes?: number; }).bytes ?? 0,
		});
	}

	private async decode(locator: ResourceLocator): Promise<Texture | null> {
		let raw = await this.resources.getResource('texture', locator);
		if (raw === null && this.atlas) {
			const sprite = await this.atlas.resolve(locator);
			if (sprite?.kind === 'pixels') {
				return sprite.texture;
			}
			if (sprite?.kind === 'file') {
				raw = await this.resources.getResource('texture', sprite.locator);
			}
		}
		if (raw === null) {
			return null;
		}
		let image;
		try {
			image = await sharp(raw).ensureAlpha().raw()
				.toBuffer({ resolveWithObject: true });
		} catch (err) {
			throw new TextureResolutionError(`Failed to decode texture ${locator}: ${(err as Error).message}`);
		}
		let texture: Texture = {
			width: image.info.width,
			height: image.info.height,
			data: new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length),
		};

		const meta = await this.readMeta(locator);
		const frame = frameSize(texture, meta);
		if (frame.height !== texture.height || frame.width !== texture.width) {
			texture = cropFrame(texture, frame.width, frame.height);
		}
		return texture;
	}

	private async readMeta(locator: ResourceLocator): Promise<TextureMeta | null> {
		const raw = await this.resources.getResource('textureMeta', locator);
		if (raw === null) {
			return null;
		}
		try {
			return JSON.parse(raw.toString('utf8')) as TextureMeta;
		} catch {
			// A broken mcmeta shouldn't lose the texture; treat it as unanimated.
			return null;
		}
	}

	/**
	 * Attach an atlas resolver, consulted when no texture file exists directly —
	 * the path that synthesizes paletted_permutations sprites (armor trims) and
	 * unstitch regions. Directory/single sources are effectively covered by the
	 * direct file lookup already.
	 */
	setAtlasResolver(atlas: AtlasResolverLike): void {
		this.atlas = atlas;
		this.cache.clear();
	}

	/**
	 * Load a texture with its animation metadata for multi-frame rendering.
	 * Returns null when the texture does not exist.
	 */
	async loadAnimated(locator: ResourceLocator): Promise<AnimatedTexture | null> {
		const raw = await this.resources.getResource('texture', locator);
		let full: Texture | null = null;
		if (raw !== null) {
			const image = await sharp(raw).ensureAlpha().raw()
				.toBuffer({ resolveWithObject: true });
			full = {
				width: image.info.width,
				height: image.info.height,
				data: new Uint8ClampedArray(image.data.buffer, image.data.byteOffset, image.data.length),
			};
		} else if (this.atlas) {
			// Atlas-synthesized sprites (trims) are never animated.
			const sprite = await this.load(locator);
			if (sprite) {
				return new AnimatedTexture(sprite, null);
			}
		}
		if (!full) {
			return null;
		}
		return new AnimatedTexture(full, await this.readMeta(locator));
	}

	/**
	 * Load a texture's first animation frame (what a static icon shows).
	 * Returns null when the texture does not exist; the caller decides whether
	 * that fails the item or just the face.
	 */
	async load(locator: ResourceLocator): Promise<Texture | null> {
		const key = locator.toString();
		const cached = this.cache.get(key);
		if (cached) {
			return cached;
		}
		const pending = this.decode(locator);
		this.cache.set(key, pending);
		// The decoded size is only known once it resolves; tagging the promise
		// keeps the weight with the entry the cache already holds.
		pending.then((texture) => {
			Object.assign(pending, { bytes: texture ? texture.data.length : 0 });
			this.cache.settle(key, pending);
		}).catch(() => {
			// A failed decode throws to the caller; the cache entry just weighs nothing.
		});
		return pending;
	}
}

/**
 * The size of one animation frame. Vertical strips are the norm (frame = width x width);
 * mcmeta may override with explicit width/height. Textures without animation metadata
 * but taller than wide are still treated as strips, matching how icons of animated
 * textures (water, fire, magma) have always been derived.
 */
function frameSize(texture: Texture, meta: TextureMeta | null): { width: number; height: number; } {
	const animation = meta?.animation;
	if (animation) {
		return {
			width: animation.width ?? texture.width,
			height: animation.height ?? (Math.min(texture.height, texture.width)),
		};
	}
	if (texture.height > texture.width && texture.height % texture.width === 0) {
		return { width: texture.width, height: texture.width };
	}
	return { width: texture.width, height: texture.height };
}

function cropFrame(texture: Texture, width: number, height: number): Texture {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let y = 0; y < height; y++) {
		const sourceStart = y * texture.width * 4;
		data.set(texture.data.subarray(sourceStart, sourceStart + width * 4), y * width * 4);
	}
	return { width, height, data };
}
