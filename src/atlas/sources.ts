/**
 * Atlas texture sources (docs/research/renderchest-spec.md §6): directory,
 * single, unstitch, paletted_permutations. Sources resolve sprite ids to
 * texture content; the resolver checks sources in reverse load order
 * (last-loaded wins, matching upstream's unshift behavior).
 */

import { ResourceLocator } from '../resources/locator.ts';

import type { Texture } from '../textures/loader.ts';

export class AtlasSourceError extends Error {}

export interface AtlasSource {
	/** Does this source provide the sprite id? */
	has(locator: ResourceLocator): boolean | Promise<boolean>;
	/** Resolve to the actual texture file locator, or synthesized pixels. */
	resolve(locator: ResourceLocator): Promise<ResolvedSprite | null>;
}

export type ResolvedSprite =
	| { kind: 'file'; locator: ResourceLocator; }
	| { kind: 'pixels'; texture: Texture; };

interface DirectorySettings {
	source: string;
	prefix: string;
}

export type HasTexture = (locator: ResourceLocator) => Promise<boolean>;

export class DirectoryAtlasSource implements AtlasSource {
	private readonly namespace: string;
	private readonly settings: DirectorySettings;
	private readonly hasTexture: HasTexture;

	constructor(namespace: string, settings: DirectorySettings, hasTexture: HasTexture) {
		this.namespace = namespace;
		this.settings = settings;
		this.hasTexture = hasTexture;
	}

	private target(locator: ResourceLocator): ResourceLocator {
		const rest = locator.path.slice(this.settings.prefix.length);
		return new ResourceLocator(locator.namespace, `${this.settings.source}/${rest}`);
	}

	/**
	 * The rewritten file must actually exist — gui.json ships a directory source
	 * with an empty prefix that would otherwise claim every sprite id.
	 */
	async has(locator: ResourceLocator): Promise<boolean> {
		if (locator.namespace !== this.namespace || !locator.path.startsWith(this.settings.prefix)) {
			return false;
		}
		return this.hasTexture(this.target(locator));
	}

	async resolve(locator: ResourceLocator): Promise<ResolvedSprite | null> {
		if (!(await this.has(locator))) {
			return null;
		}
		return { kind: 'file', locator: this.target(locator) };
	}
}

interface SingleSettings {
	resource: string;
	sprite?: string;
}

export class SingleAtlasSource implements AtlasSource {
	private readonly spriteId: ResourceLocator;
	private readonly resource: ResourceLocator;
	private readonly hasTexture: HasTexture;

	constructor(settings: SingleSettings, hasTexture: HasTexture) {
		this.resource = ResourceLocator.parse(settings.resource);
		this.spriteId = ResourceLocator.parse(settings.sprite ?? settings.resource);
		this.hasTexture = hasTexture;
	}

	async has(locator: ResourceLocator): Promise<boolean> {
		return locator.equals(this.spriteId) && this.hasTexture(this.resource);
	}

	async resolve(locator: ResourceLocator): Promise<ResolvedSprite | null> {
		return (await this.has(locator)) ? { kind: 'file', locator: this.resource } : null;
	}
}

interface PalettedPermutationsSettings {
	textures: string[];
	palette_key: string;
	permutations: Record<string, string>;
	separator?: string;
}

/**
 * Armor-trim style palette swaps: a key palette maps colors → indices; each
 * permutation palette replaces pixels whose exact RGBA matches a key entry
 * with the pixel at the same row-major index in the permutation image.
 */
export class PalettedPermutationsSource implements AtlasSource {
	private static encode(r: number, g: number, b: number, a: number): number {
		// Upstream packs (r<<24)|(g<<16)|(b<<8)|a; use unsigned math to avoid JS
		// 32-bit sign flip on r >= 128.
		return r * 0x1_00_00_00 + g * 0x1_00_00 + b * 0x1_00 + a;
	}

	private readonly settings: PalettedPermutationsSettings;
	private readonly sprites = new Map<string, { base: ResourceLocator; palette: ResourceLocator; }>();
	private keyPalette: Map<number, number> | null = null;

	private readonly loadTexture: (locator: ResourceLocator) => Promise<Texture | null>;

	constructor(
		settings: PalettedPermutationsSettings,
		loadTexture: (locator: ResourceLocator) => Promise<Texture | null>,
	) {
		this.loadTexture = loadTexture;
		this.settings = settings;
		const separator = settings.separator ?? '_';
		for (const [name, palette] of Object.entries(settings.permutations)) {
			const paletteLocator = ResourceLocator.parse(palette);
			for (const base of settings.textures) {
				const baseLocator = ResourceLocator.parse(base.replace(/\.png$/, ''));
				const sprite = new ResourceLocator(baseLocator.namespace, `${baseLocator.path}${separator}${name}`);
				this.sprites.set(sprite.toString(), {
					base: baseLocator,
					// Newer format resolves palettes under textures/palettes/ via the
					// palette locator path itself; the locator here is used verbatim.
					palette: paletteLocator,
				});
			}
		}
	}

	private async getKeyPalette(): Promise<Map<number, number>> {
		if (this.keyPalette) {
			return this.keyPalette;
		}
		const keyTexture = await this.loadTexture(ResourceLocator.parse(this.settings.palette_key));
		if (!keyTexture) {
			throw new AtlasSourceError(`Missing palette key ${this.settings.palette_key}`);
		}
		const palette = new Map<number, number>();
		for (let index = 0; index < keyTexture.width * keyTexture.height; index++) {
			const offset = index * 4;
			// Duplicate colors: last occurrence wins (Map.set overwrite = upstream array write).
			palette.set(PalettedPermutationsSource.encode(
				keyTexture.data[offset],
				keyTexture.data[offset + 1],
				keyTexture.data[offset + 2],
				keyTexture.data[offset + 3],
			), index);
		}
		this.keyPalette = palette;
		return palette;
	}

	has(locator: ResourceLocator): boolean {
		return this.sprites.has(locator.toString());
	}

	async resolve(locator: ResourceLocator): Promise<ResolvedSprite | null> {
		const sprite = this.sprites.get(locator.toString());
		if (!sprite) {
			return null;
		}
		const base = await this.loadTexture(sprite.base);
		if (!base) {
			return null;
		}
		const permutation = await this.loadTexture(sprite.palette);
		if (!permutation) {
			return null;
		}
		const keyPalette = await this.getKeyPalette();

		const data = new Uint8ClampedArray(base.data);
		for (let offset = 0; offset < data.length; offset += 4) {
			const index = keyPalette.get(PalettedPermutationsSource.encode(
				data[offset], data[offset + 1], data[offset + 2], data[offset + 3],
			));
			if (index === undefined) {
				continue;
			}
			const x = index % permutation.width;
			const y = Math.floor(index / permutation.width);
			if (y >= permutation.height) {
				continue;
			}
			const src = (y * permutation.width + x) * 4;
			data[offset] = permutation.data[src];
			data[offset + 1] = permutation.data[src + 1];
			data[offset + 2] = permutation.data[src + 2];
			data[offset + 3] = permutation.data[src + 3];
		}
		return { kind: 'pixels', texture: { width: base.width, height: base.height, data } };
	}
}

interface UnstitchRegion {
	sprite: string;
	x: number;
	y: number;
	width: number;
	height: number;
}

interface UnstitchSettings {
	resource: string;
	regions: UnstitchRegion[];
	divisor_x?: number;
	divisor_y?: number;
}

export class UnstitchAtlasSource implements AtlasSource {
	private readonly settings: UnstitchSettings;
	private readonly loadTexture: (locator: ResourceLocator) => Promise<Texture | null>;

	constructor(settings: UnstitchSettings, loadTexture: (locator: ResourceLocator) => Promise<Texture | null>) {
		this.settings = settings;
		this.loadTexture = loadTexture;
	}

	has(locator: ResourceLocator): boolean {
		return this.settings.regions.some(region => ResourceLocator.parse(region.sprite).equals(locator));
	}

	async resolve(locator: ResourceLocator): Promise<ResolvedSprite | null> {
		const region = this.settings.regions.find(entry => ResourceLocator.parse(entry.sprite).equals(locator));
		if (!region) {
			return null;
		}
		const base = await this.loadTexture(ResourceLocator.parse(this.settings.resource));
		if (!base) {
			return null;
		}
		const divisorX = this.settings.divisor_x ?? 1;
		const divisorY = this.settings.divisor_y ?? 1;
		// Correctly uses base.height for the vertical scale — upstream reads the
		// width there (a bug we do not reproduce; square vanilla atlases hide it).
		const width = Math.round(region.width / divisorX * base.width);
		const height = Math.round(region.height / divisorY * base.height);
		const left = Math.round(region.x / divisorX * base.width);
		const top = Math.round(region.y / divisorY * base.height);

		const data = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) {
			const srcStart = ((top + y) * base.width + left) * 4;
			data.set(base.data.subarray(srcStart, srcStart + width * 4), y * width * 4);
		}
		return { kind: 'pixels', texture: { width, height, data } };
	}
}

/**
 * Parses one atlas JSON's sources array. Unknown types are reported and
 * skipped rather than failing the file — mods ship experimental source types,
 * and losing a whole atlas over one is how items vanish.
 */
export function parseAtlasSources(
	namespace: string,
	atlasJson: { sources?: Array<Record<string, unknown>>; },
	loadTexture: (locator: ResourceLocator) => Promise<Texture | null>,
	onUnknown?: (type: string) => void,
	hasTexture: HasTexture = async locator => (await loadTexture(locator)) !== null,
): AtlasSource[] {
	const sources: AtlasSource[] = [];
	for (const entry of atlasJson.sources ?? []) {
		const type = String(entry.type ?? '').replace(/^minecraft:/, '');
		switch (type) {
			case 'directory': {
				sources.push(new DirectoryAtlasSource(namespace, entry as unknown as DirectorySettings, hasTexture));
				break;
			}
			case 'single': {
				sources.push(new SingleAtlasSource(entry as unknown as SingleSettings, hasTexture));
				break;
			}
			case 'paletted_permutations': {
				sources.push(new PalettedPermutationsSource(entry as unknown as PalettedPermutationsSettings, loadTexture));
				break;
			}
			case 'unstitch': {
				sources.push(new UnstitchAtlasSource(entry as unknown as UnstitchSettings, loadTexture));
				break;
			}
			case 'filter': {
				// Vanilla's filter source only excludes sprites from stitching; icons
				// resolve individual files, so it has no effect here.
				break;
			}
			default: {
				onUnknown?.(String(entry.type));
			}
		}
	}
	return sources;
}

export interface AtlasResolver {
	resolve(locator: ResourceLocator): Promise<ResolvedSprite | null>;
}

/** Sources checked in reverse insertion order (last added wins), per upstream. */
export function createAtlasResolver(sources: AtlasSource[]): AtlasResolver {
	return {
		async resolve(locator: ResourceLocator): Promise<ResolvedSprite | null> {
			for (let i = sources.length - 1; i >= 0; i--) {
				if (await sources[i].has(locator)) {
					return sources[i].resolve(locator);
				}
			}
			return null;
		},
	};
}
