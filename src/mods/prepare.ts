/**
 * Mod asset composition: mod jars layered under the vanilla base (vanilla wins
 * the `minecraft` namespace, but mod-provided vanilla textures fill gaps —
 * roughly half of the old pipeline's missing-texture failures were paths some
 * jar already held), plus synthesized item models per namespace.
 */

import { curatedModelOverrides } from './models.ts';
import { synthesizeItemModels } from './synthesize.ts';
import { curatedTintOverrides, harvestTintOverrides } from './tints.ts';
import { JarResourceManager, UnsafeJarError } from '../resources/jar.ts';
import { LayeredResourceManager } from '../resources/manager.ts';

import type { ResourceManager } from '../resources/manager.ts';

/** Loader-owned namespaces that never contain renderable mod items. */
export const LOADER_NAMESPACES = new Set(['minecraft', 'forge', 'neoforge', 'fabric', 'fabricloader', 'c', 'quilt', 'realms']);

export interface ModPreparation {
	resources: ResourceManager;
	/** Renderable mod namespaces discovered across the jars. */
	namespaces: string[];
	/** Models synthesized for texture-only namespaces. */
	synthesized: number;
	/** Items given a tint harvested from a donor jar. */
	tintOverrides: number;
	/** Jars rejected (unsafe entries) or unreadable, with reasons. */
	rejected: Array<{ jar: string; reason: string; }>;
}

export interface PrepareModsOptions {
	jars: string[];
	/** Vanilla assets for the target version (wins the minecraft namespace). */
	vanilla: ResourceManager;
	/**
	 * Jars from 1.21.4+ releases of the same mods, read only for the tints their
	 * item definitions state as data (see src/mods/tints.ts).
	 */
	tintDonors?: string[];
	onProgress?: (message: string) => void;
}

/** A namespace must ship item-ish content to be worth rendering. */
async function hasItemContent(resources: ResourceManager, namespace: string): Promise<boolean> {
	const definitions = await resources.listResources('itemDefinition', namespace);
	if (definitions.length > 0) {
		return true;
	}
	for (const locator of await resources.listResources('model', namespace)) {
		if (locator.path.startsWith('item/')) {
			return true;
		}
	}
	for (const locator of await resources.listResources('texture', namespace)) {
		if (/^(?:item|items|block|blocks)\//.test(locator.path)) {
			return true;
		}
	}
	return false;
}

export async function prepareModResources(options: PrepareModsOptions): Promise<ModPreparation> {
	const jarLayers: JarResourceManager[] = [];
	const rejected: Array<{ jar: string; reason: string; }> = [];
	const namespaceSet = new Set<string>();

	for (const jar of options.jars) {
		const manager = new JarResourceManager(jar);
		try {
			for (const namespace of await manager.listNamespaces()) {
				if (!LOADER_NAMESPACES.has(namespace)) {
					namespaceSet.add(namespace);
				}
			}
			jarLayers.push(manager);
		} catch (err) {
			// Unsafe archives are rejected whole — traversal entries mean the jar
			// can't be trusted at all.
			rejected.push({ jar, reason: err instanceof UnsafeJarError ? err.message : (err as Error).message });
			await manager.close().catch(() => {});
		}
	}

	// Vanilla wins minecraft:, jars win their own namespaces and backfill
	// mod-added vanilla paths. Curated tints and models sit above the jars on
	// purpose — see src/mods/tints.ts and src/mods/models.ts.
	const base = new LayeredResourceManager([
		options.vanilla,
		curatedTintOverrides(),
		curatedModelOverrides(),
		...jarLayers,
	]);

	const namespaces: string[] = [];
	let synthesized = 0;
	const synthLayers: ResourceManager[] = [];
	for (const namespace of [...namespaceSet].toSorted((left, right) => left.localeCompare(right))) {
		if (!(await hasItemContent(base, namespace))) {
			continue;
		}
		namespaces.push(namespace);
		const result = await synthesizeItemModels(base, namespace);
		if (result.synthesized > 0) {
			synthesized += result.synthesized;
			synthLayers.push(result.models);
			options.onProgress?.(`Synthesized ${result.synthesized} item models for ${namespace}`);
		}
	}

	let tintOverrides = 0;
	const tintLayers: ResourceManager[] = [];
	if (options.tintDonors?.length) {
		const donorJars = options.tintDonors.map(jar => new JarResourceManager(jar));
		try {
			const harvest = await harvestTintOverrides({
				donors: new LayeredResourceManager(donorJars),
				target: base,
			});
			if (harvest.harvested > 0) {
				tintLayers.push(harvest.overrides);
				tintOverrides = harvest.harvested;
				options.onProgress?.(`Harvested tints for ${harvest.harvested} items from ${donorJars.length} donor jars`);
			}
		} finally {
			// Donors are read once here and never rendered from.
			await Promise.all(donorJars.map(jar => jar.close().catch(() => {})));
		}
	}

	return {
		// Synthesized models and harvested tints sit BELOW the real tree: a mod's
		// own model or definition always wins.
		resources: new LayeredResourceManager([base, ...synthLayers, ...tintLayers]),
		namespaces,
		synthesized,
		tintOverrides,
		rejected,
	};
}
