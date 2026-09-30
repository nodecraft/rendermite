/**
 * Block and item display names, from each namespace's own `en_us` lang file.
 *
 * `block.minecraft.tnt` is "TNT" and `block.minecraft.short_grass` is "Short Grass" (before 1.20.3,
 * "Grass"): the version's own English, which a consumer would otherwise guess by title-casing an id.
 * Keys with more segments than `<kind>.<ns>.<name>` are a description or a variant's label, never an
 * id, and are left out.
 */

import { ResourceLocator } from '../resources/locator.ts';

import type { ResourceManager } from '../resources/manager.ts';

/** `names.json`: display names by id, one table per registry. */
export interface NamePack {
	block: Record<string, string>;
	item: Record<string, string>;
}

const NAME_KEY_SEGMENTS = 3;

export async function collectNames(resources: ResourceManager, namespaces: readonly string[]): Promise<NamePack> {
	const names: NamePack = { block: {}, item: {} };
	for (const namespace of namespaces) {
		const raw = await resources.getResource('lang', new ResourceLocator(namespace, 'en_us'));
		if (!raw) {
			continue;
		}
		let lang: Record<string, unknown>;
		try {
			lang = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
		} catch {
			continue;
		}
		for (const [key, value] of Object.entries(lang)) {
			const parts = key.split('.');
			const [kind, keyNamespace, name] = parts;
			if (parts.length !== NAME_KEY_SEGMENTS || keyNamespace !== namespace || typeof value !== 'string') {
				continue;
			}
			if (kind === 'block' || kind === 'item') {
				names[kind][`${namespace}:${name}`] = value;
			}
		}
	}
	return names;
}
