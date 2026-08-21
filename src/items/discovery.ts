/**
 * Era-adaptive item discovery — the piece no single renderchest tag has:
 * 1.21.4+ `items/*.json` definitions when a namespace ships them, otherwise the
 * classic `models/item/*.json` scan (v2.5.2 behavior). Both yield item ids of
 * the form `<ns>:<name>`.
 */

import { InvalidItemDefinitionError, evaluateItemModel } from './definition.ts';
import { identity } from '../render/vector.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { ItemProperties, ItemRenderInstruction } from './definition.ts';
import type { ResourceManager } from '../resources/manager.ts';

export class ItemResolutionError extends Error {}

export interface DiscoveredItem {
	/** Output id, e.g. `minecraft:stone`. */
	id: string;
	source: 'definition' | 'model';
}

export interface ItemDiscoveryOptions {
	/**
	 * Drop classic item models that have no matching item/block translation.
	 * Enabled by default to avoid publishing state and template models from a
	 * raw mod jar. Prepared resource packs can disable it after applying their
	 * own registry-aware filtering, preserving renderchest's complete model scan.
	 */
	filterUntranslatedModels?: boolean;
}

export async function discoverItems(
	resources: ResourceManager,
	namespace: string,
	options: ItemDiscoveryOptions = {},
): Promise<DiscoveredItem[]> {
	const seen = new Set<string>();
	const items: DiscoveredItem[] = [];

	for (const locator of await resources.listResources('itemDefinition', namespace)) {
		const id = locator.toString();
		if (!seen.has(id)) {
			seen.add(id);
			items.push({ id, source: 'definition' });
		}
	}

	// Namespaces predating item definitions (or mods shipping both eras): scan
	// models/item — a definition for the same name wins, matching how a v5-era
	// jar would behave.
	const filterUntranslated = options.filterUntranslatedModels ?? true;
	const registered = namespace === 'minecraft' || !filterUntranslated ? null : await langRegistry(resources, namespace);
	for (const locator of await resources.listResources('model', namespace)) {
		if (!locator.path.startsWith('item/')) {
			continue;
		}
		const name = locator.path.slice('item/'.length);
		// A model-derived id with no translation key is not a registered item —
		// it's a state/aux model (bow pulling stages, meka_tool_left, cobblemon
		// *_ball_model). Armor-trim variants are also key-less but are wanted
		// icons, matching how vanilla trims render as first-class variants.
		if (registered && !registered.has(name.replaceAll('/', '.')) && !name.endsWith('_trim')) {
			continue;
		}
		const id = new ResourceLocator(locator.namespace, name).toString();
		if (!seen.has(id)) {
			seen.add(id);
			items.push({ id, source: 'model' });
		}
	}

	return items;
}

/**
 * Item/block names with a translation key in the namespace's en_us.json — the
 * closest thing to the game's item registry a jar contains (datagen writes a
 * key per registered item). Null (no gating) when the namespace has no modern
 * lang file or no item/block keys: 1.7.10-era mods use unkeyed .lang files.
 */
export async function langRegistry(resources: ResourceManager, namespace: string): Promise<Set<string> | null> {
	const raw = await resources.getResource('lang', new ResourceLocator(namespace, 'en_us'));
	if (!raw) {
		return null;
	}
	let lang: Record<string, unknown>;
	try {
		lang = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
	} catch {
		return null;
	}
	const names = new Set<string>();
	const prefixes = [`item.${namespace}.`, `block.${namespace}.`];
	for (const key of Object.keys(lang)) {
		for (const prefix of prefixes) {
			if (key.startsWith(prefix)) {
				names.add(key.slice(prefix.length));
				break;
			}
		}
	}
	return names.size > 0 ? names : null;
}

/**
 * Resolve an item id to the models to render. Definitions are evaluated with
 * static-icon properties; plain model items render the model with no tints
 * (legacy hard-coded tint tables are layered on by the caller for old eras).
 */
export async function resolveItem(
	resources: ResourceManager,
	id: string,
	properties?: ItemProperties,
): Promise<ItemRenderInstruction[]> {
	const locator = ResourceLocator.parse(id);

	const definition = await resources.getResource('itemDefinition', locator);
	if (definition !== null) {
		let parsed: { model?: unknown; };
		try {
			parsed = JSON.parse(definition.toString('utf8')) as { model?: unknown; };
		} catch {
			throw new ItemResolutionError(`Item definition is not valid JSON: ${id}`);
		}
		if (parsed.model === undefined) {
			throw new ItemResolutionError(`Item definition has no model node: ${id}`);
		}
		try {
			return evaluateItemModel(parsed.model, properties);
		} catch (err) {
			// A model type only the mod's own code knows, naming nothing we can
			// draw. Mods that ship one of these almost always still keep a plain
			// model at the conventional path for the item's resting state —
			// EnderIO's conduit item model holds the geometry and defaults to the
			// energy texture — so prefer that over losing the icon.
			const conventional = new ResourceLocator(locator.namespace, `item/${locator.path}`);
			if (err instanceof InvalidItemDefinitionError && await resources.hasResource('model', conventional)) {
				return [{ model: conventional.toString(), tints: [], transform: identity() }];
			}
			throw err;
		}
	}

	const modelLocator = new ResourceLocator(locator.namespace, `item/${locator.path}`);
	if (await resources.hasResource('model', modelLocator)) {
		return [{ model: modelLocator.toString(), tints: [], transform: identity() }];
	}

	throw new ItemResolutionError(`No item definition or item model for ${id}`);
}
