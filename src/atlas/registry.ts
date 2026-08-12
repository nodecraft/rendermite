/**
 * Collects every `atlases/*.json` across namespaces into one resolver.
 * Load order matches upstream: sources from later-loaded files win, so the
 * resolver checks sources in reverse. Unknown source types are skipped with a
 * warning rather than failing the run (mods ship experimental types).
 */

import { createAtlasResolver, parseAtlasSources } from './sources.ts';

import type { AtlasResolver, AtlasSource } from './sources.ts';
import type { ResourceLocator } from '../resources/locator.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { Texture } from '../textures/loader.ts';

export async function loadAtlasResolver(
	resources: ResourceManager,
	loadTexture: (locator: ResourceLocator) => Promise<Texture | null>,
	onWarning?: (message: string) => void,
): Promise<AtlasResolver> {
	const sources: AtlasSource[] = [];
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
					const json = JSON.parse(raw.toString('utf8')) as { sources?: Array<Record<string, unknown>>; };
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
