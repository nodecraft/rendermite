/**
 * Collects every `atlases/*.json` across namespaces into one resolver.
 * Load order matches upstream: sources from later-loaded files win, so the
 * resolver checks sources in reverse. Unknown source types are skipped with a
 * warning rather than failing the run (mods ship experimental types).
 */

import { PalettedPermutationsSource, createAtlasResolver, parseAtlasSources } from './sources.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { AtlasResolver, AtlasSource, AtlasSourceEntry } from './sources.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { Texture } from '../textures/loader.ts';

/**
 * Some mods generate flat item-trim permutations in code rather than declaring
 * them in an atlas. Infer only the exact Minecraft convention when all three
 * inputs exist: `<type>_trim.png`, `trim_palette.png`, and the requested color
 * palette. Direct files and authored atlas sources still take precedence.
 */
class InferredItemTrimSource implements AtlasSource {
	private readonly cache = new Map<string, Promise<PalettedPermutationsSource | null>>();
	private readonly resources: ResourceManager;
	private readonly loadTexture: (locator: ResourceLocator) => Promise<Texture | null>;

	constructor(
		resources: ResourceManager,
		loadTexture: (locator: ResourceLocator) => Promise<Texture | null>,
	) {
		this.resources = resources;
		this.loadTexture = loadTexture;
	}

	private async firstTexture(candidates: ResourceLocator[]): Promise<ResourceLocator | null> {
		for (const candidate of candidates) {
			if (await this.resources.hasResource('texture', candidate)) {
				return candidate;
			}
		}
		return null;
	}

	private create(locator: ResourceLocator): Promise<PalettedPermutationsSource | null> {
		const match = /^(trims\/items\/.+_trim)_(.+)$/.exec(locator.path);
		if (!match) {
			return Promise.resolve(null);
		}
		const [, basePath, variant] = match;
		return (async () => {
			const base = new ResourceLocator(locator.namespace, basePath);
			if (!(await this.resources.hasResource('texture', base))) {
				return null;
			}
			const key = await this.firstTexture([
				new ResourceLocator(locator.namespace, 'trims/color_palettes/trim_palette'),
				ResourceLocator.parse('minecraft:trims/color_palettes/trim_palette'),
			]);
			// A trim material from a mod carries its namespace in the sprite name
			// as `<namespace>-<path>`, but keeps its palette under its own
			// namespace: blue_skies-moonstone lives at
			// blue_skies:trims/color_palettes/moonstone.
			const separator = variant.indexOf('-');
			// Other mods join the two with an underscore instead, which no split can
			// tell from a material name that simply has one. Matching against the
			// namespaces actually loaded is what makes the boundary unambiguous:
			// caverns_and_chasms_copper_darker is that mod's copper_darker palette.
			const namespaces = await this.resources.listNamespaces();
			const namespaced = namespaces
				.filter(namespace => variant.startsWith(`${namespace}_`))
				.map(namespace => new ResourceLocator(namespace, `trims/color_palettes/${variant.slice(namespace.length + 1)}`));
			const candidates = [
				new ResourceLocator(locator.namespace, `trims/color_palettes/${variant}`),
				ResourceLocator.parse(`minecraft:trims/color_palettes/${variant}`),
			];
			if (separator > 0) {
				candidates.push(new ResourceLocator(variant.slice(0, separator), `trims/color_palettes/${variant.slice(separator + 1)}`));
			}
			candidates.push(...namespaced);
			const palette = await this.firstTexture(candidates);
			if (!key || !palette) {
				return null;
			}
			return new PalettedPermutationsSource({
				textures: [base.toString()],
				palette_key: key.toString(),
				permutations: { [variant]: palette.toString() },
			}, this.loadTexture);
		})();
	}

	private source(locator: ResourceLocator): Promise<PalettedPermutationsSource | null> {
		const key = locator.toString();
		let pending = this.cache.get(key);
		if (!pending) {
			pending = this.create(locator);
			this.cache.set(key, pending);
		}
		return pending;
	}

	async has(locator: ResourceLocator): Promise<boolean> {
		return (await this.source(locator)) !== null;
	}

	async resolve(locator: ResourceLocator) {
		const source = await this.source(locator);
		return source?.resolve(locator) ?? null;
	}
}

export async function loadAtlasResolver(
	resources: ResourceManager,
	loadTexture: (locator: ResourceLocator) => Promise<Texture | null>,
	onWarning?: (message: string) => void,
): Promise<AtlasResolver> {
	// Added first so reverse resolution gives every authored atlas source higher
	// priority. This is strictly a fallback for otherwise-missing generated sprites.
	const sources: AtlasSource[] = [new InferredItemTrimSource(resources, loadTexture)];
	for (const namespace of await resources.listNamespaces()) {
		const atlasFiles = await resources.listResources('atlas', namespace);
		atlasFiles.sort((a, b) => a.path.localeCompare(b.path));
		for (const file of atlasFiles) {
			// Atlas files MERGE across packs in the game (a mod's blocks.json adds
			// sources alongside vanilla's, it does not replace it) — read every
			// layer's copy. Reversed so the highest-precedence pack's sources land
			// last, where the reverse-checking resolver finds them first.
			const copies = await resources.getAllResources('atlas', file);
			copies.reverse();
			for (const raw of copies) {
				try {
					const json = JSON.parse(raw.toString('utf8')) as { sources?: AtlasSourceEntry[]; };
					sources.push(...parseAtlasSources(
						namespace,
						json,
						loadTexture,
						type => onWarning?.(`Skipping unknown atlas source type ${type} in ${file}`),
						locator => resources.hasResource('texture', locator),
					));
				} catch (err) {
					onWarning?.(`Unparseable atlas ${file}: ${(err as Error).message}`);
				}
			}
		}
	}
	return createAtlasResolver(sources);
}
