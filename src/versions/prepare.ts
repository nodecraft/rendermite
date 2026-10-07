/**
 * Version-era detection and asset preparation, replacing the file-tree surgery
 * the old pipeline did (fetch-assets.ts + legacy-assets.ts) with composed
 * resource-manager layers over the jars themselves:
 *
 * - 1.9+  — the jar as-is.
 * - 1.8.x — jar + synthesized `models/item/generated.json`.
 * - 1.6–1.7.x — jar textures + donor geometry (1.12.2 over 1.8.9, models and
 *   blockstates only) + synthesized generated.json + glint alias.
 * - <1.6 — reshaped legacy textures (see legacy-reshape.ts) + donor geometry.
 */

import { reshapeLegacyAssets } from './legacy-reshape.ts';
import { JarResourceManager } from '../resources/jar.ts';
import { ResourceLocator } from '../resources/locator.ts';
import { FolderResourceManager, LayeredResourceManager } from '../resources/manager.ts';
import { KindFilteredResourceManager, MapResourceManager } from '../resources/synthetic.ts';

import type { ResourceManager } from '../resources/manager.ts';

/** Dotted-numeric compare handling both `1.21.8` and the `26.2` scheme. */
export function compareVersions(left: string, right: string): number {
	const partsA = left.split('.').map(part => Number(part) || 0);
	const partsB = right.split('.').map(part => Number(part) || 0);
	for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
		const delta = (partsA[i] ?? 0) - (partsB[i] ?? 0);
		if (delta !== 0) {
			return Math.sign(delta);
		}
	}
	return 0;
}

export const Era = {
	/** 1.21.4+: items/ definitions. */
	modern: 'modern',
	/** 1.9–1.21.3: models/item scan. */
	models: 'models',
	/** 1.8.x: models but no models/item/generated.json. */
	earlyModels: 'earlyModels',
	/** 1.6–1.7.x: assets layout, flat textures, no JSON models. */
	preModels: 'preModels',
	/** 1.5.x: root-layout individual textures, old names. */
	legacyFiles: 'legacyFiles',
	/** ≤1.4.7: stitched terrain.png/items.png sheets. */
	legacySheets: 'legacySheets',
} as const;

export type EraName = keyof typeof Era;

export function eraForVersion(version: string): EraName {
	if (compareVersions(version, '1.21.4') >= 0) {
		return 'modern';
	}
	if (compareVersions(version, '1.9') >= 0) {
		return 'models';
	}
	if (compareVersions(version, '1.8') >= 0) {
		return 'earlyModels';
	}
	if (compareVersions(version, '1.6') >= 0) {
		return 'preModels';
	}
	if (compareVersions(version, '1.5') >= 0) {
		return 'legacyFiles';
	}
	return 'legacySheets';
}

/** Donor jars for borrowed geometry, oldest→newest; the newest wins overlaps. */
export const GEOMETRY_DONOR_VERSIONS = ['1.8.9', '1.12.2'] as const;

/** [modern path, legacy path] — extended as more era moves surface. */
const MOVED_TEXTURES: Array<[modern: string, legacy: string]> = [
	// Pre-1.19.3 glint name.
	['minecraft:misc/enchanted_glint_item', 'minecraft:misc/enchanted_item_glint'],
	// Banner/shield bases moved into per-entity folders around 1.21.9.
	['minecraft:entity/banner/banner_base', 'minecraft:entity/banner_base'],
	['minecraft:entity/shield/shield_base_nopattern', 'minecraft:entity/shield_base_nopattern'],
	['minecraft:entity/shield/shield_base', 'minecraft:entity/shield_base'],
	// Pre-1.13 shulkers only ship per-color textures (purple is the default).
	['minecraft:entity/shulker/shulker', 'minecraft:entity/shulker/shulker_purple'],
	// Steve's skin moved into per-shape folders in 1.19.3.
	['minecraft:entity/player/wide/steve', 'minecraft:entity/steve'],
];

export interface PrepareOptions {
	version: string;
	/** Path to the version's client jar. */
	jar: string;
	/** Donor jar paths by version — required below 1.8 (and the 1.6.4 reference below 1.6). */
	donors?: Partial<Record<string, string>>;
	/** 1.6.4 jar for pixel-match naming of pre-1.6 textures. */
	referenceJar?: string;
	/**
	 * Bed geometry pack for 1.21.4 through 26.1: those jars' bed item models
	 * chain to builtin/entity (vanilla only shipped real bed block models in
	 * 26.2), so the corpus era renders beds as fully transparent icons. This
	 * layer shadows them with real geometry.
	 */
	bedCompat?: string;
}

/**
 * Compose the resource layers for a version. Highest priority first:
 * era shims, then the version's own assets, then donor geometry.
 */
export async function prepareVersionResources(options: PrepareOptions): Promise<ResourceManager> {
	const era = eraForVersion(options.version);
	const layers: ResourceManager[] = [];
	const shims = new MapResourceManager();

	if (era === 'legacyFiles' || era === 'legacySheets') {
		if (!options.referenceJar) {
			throw new Error(`Versions below 1.6 need referenceJar (1.6.4) for texture naming: ${options.version}`);
		}
		layers.push(await reshapeLegacyAssets(options.jar, options.referenceJar, era === 'legacySheets'));
	} else {
		if (options.bedCompat
			&& compareVersions(options.version, '1.21.4') >= 0
			&& compareVersions(options.version, '26.2') < 0) {
			layers.push(new FolderResourceManager(options.bedCompat));
		}
		layers.push(new JarResourceManager(options.jar));
	}

	const needsDonors = (['preModels', 'legacyFiles', 'legacySheets'] as EraName[]).includes(era);
	if (needsDonors) {
		// Donors provide geometry only; the target's own textures always win.
		for (const donor of GEOMETRY_DONOR_VERSIONS.toReversed()) {
			const jar = options.donors?.[donor];
			if (!jar) {
				throw new Error(`Version ${options.version} needs donor jar ${donor} for geometry`);
			}
			layers.push(new KindFilteredResourceManager(new JarResourceManager(jar), ['model', 'blockstate']));
		}
	}

	if (era !== 'modern' && era !== 'models') {
		// models/item/generated.json only exists from 1.9; placeholders resolve through it.
		shims.set('model', 'minecraft:item/generated', JSON.stringify({ parent: 'builtin/generated' }));
	}

	if (compareVersions(options.version, '1.13') < 0) {
		// Pre-Flattening item names for code-rendered items the builtin pack only
		// covers under modern ids.
		const aliases: Array<[name: string, model: object]> = [
			['bed', { parent: 'renderchest:item/bed', textures: { texture: 'minecraft:entity/bed/red' } }],
			['banner', { parent: 'renderchest:item/banner' }],
			['shield_blocking', { parent: 'minecraft:item/shield' }],
			['skull', { parent: 'mobheads:item/skeleton' }],
			['skull_char', { parent: 'mobheads:item/player' }],
			['skull_creeper', { parent: 'mobheads:item/creeper' }],
			['skull_dragon', { parent: 'mobheads:item/ender_dragon' }],
			['skull_skeleton', { parent: 'mobheads:item/skeleton' }],
			['skull_wither', { parent: 'mobheads:item/wither_skeleton' }],
			['skull_zombie', { parent: 'mobheads:item/zombie' }],
		];
		for (const [name, model] of aliases) {
			shims.set('model', `minecraft:item/${name}`, JSON.stringify(model));
		}
	}

	const base = new LayeredResourceManager(layers);

	// Vanilla renames/moves textures between versions while the builtin pack's
	// models reference one era's paths — alias the modern name to the old file
	// when only the old one exists (and vice versa costs nothing to cover).
	for (const [modern, legacy] of MOVED_TEXTURES) {
		const modernLocator = ResourceLocator.parse(modern);
		if (await base.hasResource('texture', modernLocator)) {
			continue;
		}
		const legacyContent = await base.getResource('texture', ResourceLocator.parse(legacy));
		if (legacyContent) {
			shims.set('texture', modern, legacyContent);
		}
	}

	return new LayeredResourceManager([shims, base]);
}
