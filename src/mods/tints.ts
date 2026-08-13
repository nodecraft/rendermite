/**
 * Tints for mod items whose colors live in client code rather than asset JSON.
 * Both sources here emit ordinary 1.21.4+ item definitions, so nothing new
 * renders them: `resolveItem` reads definitions in every era and `resolveTint`
 * already accepts a `default` from any tint type.
 *
 * - Harvested: a mod's own 1.21.4+ release states its tints as data, making a
 *   newer jar of the same mod an authoritative donor for its older jars — the
 *   trick GEOMETRY_DONOR_VERSIONS plays for pre-1.8 geometry. Derived, so it
 *   layers BELOW the real tree and the mod's own data always wins.
 * - Curated (`assets/mod-tints/`): the residue no release ever turned into data
 *   (AdvancedAE's quantum armor ships a code-driven model type in both eras).
 *   Hand-authored per item, so it layers ABOVE the mod jars: below them, an
 *   unrenderable code-model definition would shadow it in the modern era.
 */

import { modTintPackPath } from '../builtin.ts';
import { defaultProperties, evaluateItemModel } from '../items/definition.ts';
import { ResourceLocator } from '../resources/locator.ts';
import { FolderResourceManager } from '../resources/manager.ts';
import { MapResourceManager } from '../resources/synthetic.ts';

import type { TintDefinition } from '../items/definition.ts';
import type { ResourceManager } from '../resources/manager.ts';

/** Holds a tint slot's position without painting it (parseTintValue reads -1 as no tint). */
const NO_TINT: TintDefinition = { type: 'minecraft:constant', value: -1 };

/**
 * The color a tint resolves to with no game running: a constant's value, or any
 * type's `default`. `undefined` means the tint needs runtime state (`ae2:color`,
 * `ae2:storage_cell_state`), so only the game itself could resolve it.
 */
function staticValue(tint: TintDefinition): unknown {
	const type = typeof tint.type === 'string' && tint.type.includes(':') ? tint.type : `minecraft:${String(tint.type)}`;
	if (type === 'minecraft:constant') {
		return tint.value;
	}
	return Object.hasOwn(tint, 'default') ? tint.default : undefined;
}

/** Whether a static value actually paints (null/-1 are vanilla's "leave this layer alone"). */
function paints(value: unknown): boolean {
	return value !== undefined && value !== null && value !== -1;
}

export interface HarvestTintsOptions {
	/** Assets from 1.21.4+ releases of the same mods, read only for their tints. */
	donors: ResourceManager;
	/** The tree being rendered; only items it already models are given overrides. */
	target: ResourceManager;
	/** Namespaces to harvest; defaults to every mod namespace the donors declare. */
	namespaces?: string[];
}

export interface HarvestedTints {
	overrides: MapResourceManager;
	/** Items given a tint override — reported so a harvest is never silent. */
	harvested: number;
}

/**
 * Copy resolvable tints from a donor's item definitions onto the target's own
 * item models. Only the static GUI branch of a donor definition is read, and
 * only when it resolves to a single model: a composite has no one old model to
 * bind to. Slots the donor leaves to runtime state are held open rather than
 * dropped, keeping every later tint on the layer it belongs to.
 */
export async function harvestTintOverrides(options: HarvestTintsOptions): Promise<HarvestedTints> {
	const overrides = new MapResourceManager();
	let harvested = 0;
	// A mod jar may hold vanilla-namespace definitions; vanilla's own tints are
	// never sourced from a mod, and loader namespaces carry no items at all.
	const candidates = options.namespaces ?? await options.donors.listNamespaces();
	const namespaces = candidates.filter(namespace => namespace !== 'minecraft');

	for (const namespace of namespaces) {
		for (const locator of await options.donors.listResources('itemDefinition', namespace)) {
			const raw = await options.donors.getResource('itemDefinition', locator);
			if (!raw) {
				continue;
			}
			let tints: TintDefinition[];
			try {
				const parsed = JSON.parse(raw.toString('utf8')) as { model?: unknown; };
				const instructions = evaluateItemModel(parsed.model, defaultProperties());
				if (instructions.length !== 1) {
					continue;
				}
				tints = instructions[0].tints;
			} catch {
				// Unparseable, or a code-registered model type we can't evaluate —
				// either way the donor states no tints we can use.
				continue;
			}
			if (!tints.some(tint => paints(staticValue(tint)))) {
				continue;
			}

			// The target must already model the item (no inventing ids), and a
			// definition of its own outranks anything derived from another release.
			const model = new ResourceLocator(locator.namespace, `item/${locator.path}`);
			if (await options.target.hasResource('itemDefinition', locator) || !(await options.target.hasResource('model', model))) {
				continue;
			}
			overrides.set('itemDefinition', locator, JSON.stringify({
				model: {
					type: 'minecraft:model',
					model: model.toString(),
					tints: tints.map(tint => (staticValue(tint) === undefined ? NO_TINT : tint)),
				},
			}));
			harvested++;
		}
	}

	return { overrides, harvested };
}

/** The vendored curated overrides (see assets/mod-tints/README.md). */
export function curatedTintOverrides(): ResourceManager {
	return new FolderResourceManager(modTintPackPath());
}
