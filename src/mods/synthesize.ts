/**
 * Model synthesis for mods that ship textures without item models, ported from
 * the ui pipeline's synthesizeItemModels. Every rule below was earned on the
 * 419k-item modded run:
 * - a real model from the mod always beats a synthesized one;
 * - lang-declared ids filter out invented items (a mod with no lang file
 *   synthesizes everything — losing coverage is worse than a few extras);
 * - the item sprite wins name collisions with block sprites (one model per name);
 * - block textures another model draws as faces are custom geometry — wrapping
 *   a UV atlas over a cube renders scrambled, so skip;
 * - `<id>_base` block models with no `<id>` are code-built block entities, skip;
 * - face-suffixed textures (_top, _side…) are parts, not items.
 */

import { ResourceLocator } from '../resources/locator.ts';
import { MapResourceManager } from '../resources/synthetic.ts';

import type { ResourceManager } from '../resources/manager.ts';

const BLOCK_FACE_SUFFIXES = ['_top', '_bottom', '_side', '_front', '_back', '_end', '_inner', '_overlay'];

/** Texture directories by era: modern singular and pre-1.13 plural. */
const ITEM_TEXTURE_DIRS = ['item', 'items'] as const;
const BLOCK_TEXTURE_DIRS = ['block', 'blocks'] as const;

async function textureNames(resources: ResourceManager, namespace: string, directories: readonly string[]): Promise<Map<string, string>> {
	const names = new Map<string, string>();
	for (const directory of directories) {
		for (const locator of await resources.listResources('texture', namespace)) {
			if (!locator.path.startsWith(`${directory}/`)) {
				continue;
			}
			const name = locator.path.slice(directory.length + 1);
			// Nested paths (item/foo/bar) synthesize with their full path as the id tail.
			if (!names.has(name)) {
				names.set(name, locator.path);
			}
		}
	}
	return names;
}

/** Ids declared by the mod's own lang file (item.<ns>.<id> / block.<ns>.<id>). */
async function declaredItemIds(resources: ResourceManager, namespace: string): Promise<Set<string> | null> {
	const lang = await resources.getResource('lang', ResourceLocator.parse(`${namespace}:en_us`));
	if (!lang) {
		return null;
	}
	try {
		const entries = JSON.parse(lang.toString('utf8')) as Record<string, unknown>;
		const declared = new Set<string>();
		const pattern = new RegExp(String.raw`^(?:item|block)\.${namespace}\.(.+)$`);
		for (const key of Object.keys(entries)) {
			const match = pattern.exec(key);
			if (match) {
				// Sub-keys (piano_roll.chopsticks) collapse to their first segment.
				declared.add(match[1].split('.', 1)[0]);
			}
		}
		return declared;
	} catch {
		return null;
	}
}

/** Every texture referenced as a face by any of the namespace's models. */
async function referencedBlockTextures(resources: ResourceManager, namespace: string): Promise<Set<string>> {
	const used = new Set<string>();
	for (const locator of await resources.listResources('model', namespace)) {
		const raw = await resources.getResource('model', locator);
		if (!raw) {
			continue;
		}
		try {
			const json = JSON.parse(raw.toString('utf8')) as { textures?: Record<string, string>; };
			for (const value of Object.values(json.textures ?? {})) {
				if (typeof value !== 'string' || value.startsWith('#')) {
					continue;
				}

				const normalized = value.includes(':') ? value : `${namespace}:${value}`;
				if (normalized.startsWith(`${namespace}:block/`) || normalized.startsWith(`${namespace}:blocks/`)) {
					used.add(normalized.split('/').slice(1).join('/'));
				}
			}
		} catch {
			// Unparseable models were already reported by the model loader path.
		}
	}
	return used;
}

export interface SynthesisResult {
	models: MapResourceManager;
	synthesized: number;
}

export async function synthesizeItemModels(resources: ResourceManager, namespace: string): Promise<SynthesisResult> {
	const output = new MapResourceManager();
	let synthesized = 0;

	const existingModels = new Set<string>();
	const blockModels = new Set<string>();
	for (const locator of await resources.listResources('model', namespace)) {
		if (locator.path.startsWith('item/')) {
			existingModels.add(locator.path.slice('item/'.length));
		} else if (locator.path.startsWith('block/')) {
			blockModels.add(locator.path.slice('block/'.length));
		}
	}

	const declared = await declaredItemIds(resources, namespace);
	const wanted = (name: string) => !declared || declared.size === 0 || declared.has(name);

	const itemTextures = await textureNames(resources, namespace, ITEM_TEXTURE_DIRS);
	const blockTextures = await textureNames(resources, namespace, BLOCK_TEXTURE_DIRS);
	const usedTextures = await referencedBlockTextures(resources, namespace);

	const claimed = new Set<string>();
	for (const [name, texturePath] of itemTextures) {
		if (existingModels.has(name) || !wanted(name)) {
			continue;
		}
		output.set('model', `${namespace}:item/${name}`, JSON.stringify({
			parent: 'item/generated',
			textures: { layer0: `${namespace}:${texturePath}` },
		}));
		claimed.add(name);
		synthesized++;
	}

	for (const [name, texturePath] of blockTextures) {
		if (existingModels.has(name) || claimed.has(name) || !wanted(name)) {
			continue;
		}
		if (BLOCK_FACE_SUFFIXES.some(suffix => name.endsWith(suffix))) {
			continue;
		}
		if (blockModels.has(name)) {
			// The mod's own geometry always wins; its existence is the declaration.
			output.set('model', `${namespace}:item/${name}`, JSON.stringify({ parent: `${namespace}:block/${name}` }));
			synthesized++;
			continue;
		}
		if (usedTextures.has(texturePath.split('/').slice(1).join('/')) || usedTextures.has(name)) {
			continue;
		}
		if (blockModels.has(`${name}_base`)) {
			continue;
		}
		const directory = texturePath.split('/', 1)[0];
		const topName = blockTextures.has(`${name}_top`) ? `${namespace}:${directory}/${name}_top` : null;
		const sideName = blockTextures.has(`${name}_side`) ? `${namespace}:${directory}/${name}_side` : `${namespace}:${texturePath}`;
		if (topName) {
			output.set('model', `${namespace}:item/${name}`, JSON.stringify({
				parent: 'block/cube_bottom_top',
				textures: { top: topName, bottom: topName, side: sideName },
			}));
		} else {
			output.set('model', `${namespace}:item/${name}`, JSON.stringify({
				parent: 'block/cube_all',
				textures: { all: sideName },
			}));
		}
		synthesized++;
	}

	return { models: output, synthesized };
}
