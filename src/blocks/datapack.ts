/**
 * The version's own datapack, read out of the client jar: tags and advancements.
 *
 * Every client jar from 1.13 carries the integrated server's vanilla datapack under `data/`, so these
 * are the version's answer rather than a transcription of one. A consumer that hardcodes them instead
 * ends up offering a 1.18 world the blocks of a 26.x tag.
 *
 * Tags stay unexpanded, `#references` and all: the expanded form is several times the size, and a
 * consumer expands once on load.
 */

import type { ResourceManager } from '../resources/manager.ts';

/** `tags.json`: registry (`block`, `item`, `worldgen/biome`, …) → tag id → its values, unexpanded. */
export type TagPack = Record<string, Record<string, string[]>>;

/** `advancements.json`: advancement id → the names of its criteria. Recipe unlocks are left out. */
export type AdvancementPack = Record<string, string[]>;

/**
 * 1.21 renamed the tag folders to the registry's singular name. Normalised here so a consumer asks
 * for `block` at every version rather than knowing which spelling a jar used.
 */
const PLURAL_TAG_FOLDERS: Record<string, string> = {
	blocks: 'block',
	items: 'item',
	fluids: 'fluid',
	entity_types: 'entity_type',
	game_events: 'game_event',
	functions: 'function',
};

/** `advancements/` before 1.21, `advancement/` from it. */
const ADVANCEMENT_FOLDER = /^advancements?\//;

async function readJson(resources: ResourceManager, locator: Parameters<ResourceManager['getResource']>[1]): Promise<unknown> {
	const raw = await resources.getResource('data', locator);
	if (raw === null) {
		return null;
	}
	try {
		return JSON.parse(raw.toString('utf8'));
	} catch {
		return null;
	}
}

export interface DatapackResult {
	tags: TagPack;
	advancements: AdvancementPack;
	/** Files that were listed but would not parse, by `namespace:path`. */
	unreadable: string[];
}

export async function collectDatapack(resources: ResourceManager, namespaces: readonly string[]): Promise<DatapackResult> {
	const tags: TagPack = {};
	const advancements: AdvancementPack = {};
	const unreadable: string[] = [];
	for (const namespace of namespaces) {
		const listed = await resources.listResources('data', namespace);
		for (const locator of listed.toSorted((left, right) => left.path.localeCompare(right.path))) {
			const tag = /^tags\/(.+)$/.exec(locator.path);
			if (tag) {
				// The registry is every folder but the last few, which are the tag's own path: `tags/worldgen/biome/is_ocean`
				// is the `worldgen/biome` registry's `is_ocean`. Only the known multi-segment registries are worldgen ones.
				const rest = tag[1];
				const worldgen = /^(worldgen\/[^/]+)\/(.+)$/.exec(rest);
				const split = worldgen ?? /^([^/]+)\/(.+)$/.exec(rest);
				if (!split) {
					continue;
				}
				const registry = PLURAL_TAG_FOLDERS[split[1]] ?? split[1];
				const json = await readJson(resources, locator) as { values?: unknown; } | null;
				if (!Array.isArray(json?.values)) {
					unreadable.push(locator.toString());
					continue;
				}
				// An optional entry names something another pack may add; its id is all a consumer can use
				const values = json.values.flatMap((value: unknown) => {
					if (typeof value === 'string') {
						return [value];
					}
					const id = (value as { id?: unknown; } | null)?.id;
					return typeof id === 'string' ? [id] : [];
				});
				tags[registry] ??= {};
				tags[registry][`${namespace}:${split[2]}`] = values;
				continue;
			}
			if (!ADVANCEMENT_FOLDER.test(locator.path)) {
				continue;
			}
			const name = locator.path.replace(ADVANCEMENT_FOLDER, '');
			// Hundreds of these, all granted silently by the game; nothing a consumer lists
			if (name.startsWith('recipes/')) {
				continue;
			}
			const json = await readJson(resources, locator) as { criteria?: unknown; } | null;
			if (typeof json?.criteria !== 'object' || json.criteria === null) {
				unreadable.push(locator.toString());
				continue;
			}
			advancements[`${namespace}:${name}`] = Object.keys(json.criteria);
		}
	}
	return { tags, advancements, unreadable };
}
