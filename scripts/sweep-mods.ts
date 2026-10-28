/**
 * Broad real-mod coverage sweep: pulls the top item-bearing mods from Modrinth
 * for a version/loader matrix, renders every namespace, and prints per-mod
 * coverage with a failure-class rollup. Run with:
 *
 *   node scripts/sweep-mods.ts [--top 25] [--matrix 1.20.1:forge,26.2:neoforge]
 */

import path from 'node:path';
import { parseArgs } from 'node:util';

import { loadAtlasResolver } from '../src/atlas/registry.ts';
import { builtinPackPath } from '../src/builtin.ts';
import { defaultProperties } from '../src/items/definition.ts';
import { discoverItems, resolveItem } from '../src/items/discovery.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { prepareModResources } from '../src/mods/prepare.ts';
import { toByteTexture } from '../src/render/blend.ts';
import { renderEntityFallback } from '../src/render/entity-fallback.ts';
import { findGeoForItem, renderGeo } from '../src/render/geo.ts';
import { legacyTintsForChain } from '../src/render/legacy-tints.ts';
import { renderModel } from '../src/render/renderer.ts';
import { resolveTints } from '../src/render/tints.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { FolderResourceManager, LayeredResourceManager } from '../src/resources/manager.ts';
import { TextureLoader } from '../src/textures/loader.ts';
import { eraForVersion } from '../src/versions/prepare.ts';
import { ensureModrinthJar, ensureVanillaJar, fixturesDir } from '../test/fixtures/index.ts';

import type { ModrinthSpec } from '../test/fixtures/index.ts';

const { values } = parseArgs({
	options: {
		top: { type: 'string', default: '25' },
		matrix: { type: 'string', default: '26.2:neoforge,1.21.1:neoforge,1.20.1:forge,1.20.1:fabric' },
		slugs: { type: 'string' },
	},
});

interface SearchHit {
	slug: string;
	title: string;
	server_side: string;
	categories: string[];
}

/** Content categories that actually add items — raw download rank is all libraries. */
const CONTENT_CATEGORIES = [
	'technology',
	'magic',
	'equipment',
	'food',
	'storage',
	'adventure',
	'decoration',
	'transportation',
	'mobs',
	'worldgen',
];

async function topMods(gameVersion: string, loader: string): Promise<SearchHit[]> {
	const facets = JSON.stringify([
		['project_type:mod'],
		[`versions:${gameVersion}`],
		[`categories:${loader}`],
		CONTENT_CATEGORIES.map(category => `categories:${category}`),
	]);
	const query = new URLSearchParams({ limit: '100', index: 'downloads', facets });
	const response = await fetch(`https://api.modrinth.com/v2/search?${query}`, {
		headers: { 'user-agent': 'nodecraft/rendermite sweep (https://github.com/nodecraft/rendermite)' },
	});
	if (!response.ok) {
		throw new Error(`Modrinth search failed: ${response.status}`);
	}
	const body = await response.json() as { hits: SearchHit[]; };
	// Client-only mods register no items; libraries/optimizers rarely do either
	// (the head of any download ranking is exactly those).
	return body.hits
		.filter(hit => hit.server_side !== 'unsupported')
		.filter(hit => !hit.categories.some(category => category === 'library' || category === 'optimization'));
}

/**
 * Known item-heavy mods worth always sweeping, per cell where they exist. The
 * newest cell leads: a mod's current release is what most reports are about, and
 * mods routinely fix in a new version what looks like a renderer bug in an old
 * one (waystones moved its sharestone tints from client code into item-definition
 * data). The older cells stay so legacy-era regressions still surface.
 */
const SEEDS: Record<string, string[]> = {
	'26.2:neoforge': ['waystones', 'bloom', 'ae2', 'supplementaries', 'sophisticated-backpacks', 'create'],
	'1.20.1:forge': ['ae2', 'mekanism', 'botania', 'supplementaries', 'iron-chests', 'waystones', 'alexs-mobs', 'aether', 'create', 'farmers-delight', 'twilightforest', 'immersiveengineering'],
	'1.21.1:neoforge': ['ae2', 'mekanism', 'supplementaries', 'waystones', 'aether', 'create', 'sophisticated-backpacks', 'iron-chests'],
	'1.20.1:fabric': ['create-fabric', 'farmers-delight-fabric', 'croptopia', 'spectrum', 'bosses-of-mass-destruction', 'deeperdarker'],
};

interface ModReport {
	slug: string;
	gameVersion: string;
	loader: string;
	namespaces: number;
	items: number;
	rendered: number;
	geoRendered: number;
	entityFallbacks: number;
	spriteFallbacks: number;
	failureClasses: Map<string, number>;
	failureSamples: string[];
	error?: string;
}

async function sweepMod(spec: ModrinthSpec, vanillaVersion: string): Promise<ModReport> {
	const report: ModReport = {
		slug: spec.slug,
		gameVersion: spec.gameVersion,
		loader: spec.loader,
		namespaces: 0,
		items: 0,
		rendered: 0,
		geoRendered: 0,
		entityFallbacks: 0,
		spriteFallbacks: 0,
		failureClasses: new Map(),
		failureSamples: [],
	};
	try {
		const jar = await ensureModrinthJar(spec);
		const preparation = await prepareModResources({
			jars: [jar],
			vanilla: new JarResourceManager(await ensureVanillaJar(vanillaVersion)),
		});
		const era = eraForVersion(vanillaVersion);
		const resources = new LayeredResourceManager([
			new FolderResourceManager(builtinPackPath(era === 'modern' ? 'modern' : 'legacy')),
			preparation.resources,
		]);
		report.namespaces = preparation.namespaces.length;
		const textures = new TextureLoader(resources);
		textures.setAtlasResolver(await loadAtlasResolver(resources, locator => textures.load(locator)));
		const models = new ModelLoader(resources);

		for (const namespace of preparation.namespaces) {
			for (const item of await discoverItems(resources, namespace)) {
				report.items++;
				try {
					const instructions = await resolveItem(resources, item.id, defaultProperties());
					let content = false;
					for (const instruction of instructions) {
						const model = await models.load(instruction.model);
						const tints = instruction.tints.length > 0
							? await resolveTints(instruction.tints, { textures })
							: await legacyTintsForChain(model.chain, textures) ?? [];
						const rendered = toByteTexture(await renderModel(model, textures, {
							size: 64,
							quality: 2,
							lightingProfile: 'modern',
							itemTransform: instruction.transform,
							tints,
							resources,
						}));
						for (let offset = 3; offset < rendered.data.length; offset += 4) {
							if (rendered.data[offset] > 0) {
								content = true;
								break;
							}
						}
					}
					if (content || instructions.length === 0) {
						report.rendered++;
					} else {
						bump(report, 'rendered empty', item.id);
					}
				} catch (err) {
					// Same fallback chain run() uses.
					const geo = await findGeoForItem(resources, item.id).catch(() => null);
					const geoRender = geo
						? await renderGeo(geo.geo, geo.texture, textures, { size: 64, quality: 2, lightingProfile: 'modern' }).catch(() => null)
						: null;
					if (geoRender) {
						report.rendered++;
						report.geoRendered++;
						continue;
					}
					const entityRender = await renderEntityFallback(item.id, models, textures, resources, { size: 64, quality: 2, lightingProfile: 'modern', resources }).catch(() => null);
					if (entityRender) {
						report.rendered++;
						report.entityFallbacks++;
						continue;
					}
					const locatorPath = item.id.split(':', 2)[1];
					const sprite = await textures.load(new ResourceLocator(namespace, `item/${locatorPath}`)).catch(() => null);
					if (sprite) {
						report.rendered++;
						report.spriteFallbacks++;
						continue;
					}
					bump(report, classify((err as Error).message), `${item.id} :: ${(err as Error).message.slice(0, 70)}`);
				}
			}
		}
	} catch (err) {
		report.error = (err as Error).message.slice(0, 100);
	}
	return report;
}

function classify(message: string): string {
	if (message.includes('No drawable geometry')) {
		return 'code-rendered, no fallback';
	}
	if (message.includes('Missing texture')) {
		return 'missing texture';
	}
	if (message.includes('Model not found')) {
		return 'missing model/parent';
	}
	if (message.includes('Generated model without layers')) {
		return 'generated without layers';
	}
	if (message.includes('OBJ')) {
		return 'obj issue';
	}
	return `other: ${message.slice(0, 40)}`;
}

function bump(report: ModReport, key: string, sample: string): void {
	report.failureClasses.set(key, (report.failureClasses.get(key) ?? 0) + 1);
	if (report.failureSamples.length < 5) {
		report.failureSamples.push(sample);
	}
}

const matrix = (values.matrix ?? '').split(',').map((entry) => {
	const [gameVersion, loader] = entry.split(':', 2);
	return { gameVersion, loader: loader as ModrinthSpec['loader'] };
});
const top = Number(values.top);

console.log(`Sweeping top ${top} mods per cell across: ${values.matrix}`);
console.log(`Cache: ${path.join(fixturesDir, 'modrinth')}\n`);

const totals = { items: 0, rendered: 0, geo: 0, sprites: 0 };
const globalFailures = new Map<string, number>();

for (const cell of matrix) {
	const vanilla = cell.gameVersion === '1.20.1' ? '1.20.4' : cell.gameVersion;
	const seeds = SEEDS[`${cell.gameVersion}:${cell.loader}`] ?? [];
	const hits = values.slugs ? [] : await topMods(cell.gameVersion, cell.loader);
	const crawled = hits.map(hit => hit.slug);
	const slugs = values.slugs ? values.slugs.split(',') : [...new Set([...seeds, ...crawled])];
	console.log(`=== ${cell.gameVersion} ${cell.loader} ===`);
	let swept = 0;
	for (const slug of slugs) {
		if (swept >= top) {
			break;
		}
		const report = await sweepMod({ slug, gameVersion: cell.gameVersion, loader: cell.loader }, vanilla);
		if (report.error) {
			console.log(`  ${slug.padEnd(30)} ERROR: ${report.error}`);
			continue;
		}
		if (report.items === 0) {
			continue;
		}
		swept++;
		totals.items += report.items;
		totals.rendered += report.rendered;
		totals.geo += report.geoRendered;
		totals.sprites += report.spriteFallbacks;
		const coverage = (report.rendered / report.items * 100).toFixed(1);
		const extras = [
			report.geoRendered ? `${report.geoRendered} geo` : '',
			report.entityFallbacks ? `${report.entityFallbacks} entity` : '',
			report.spriteFallbacks ? `${report.spriteFallbacks} sprite` : '',
		].filter(Boolean).join(', ');
		console.log(`  ${slug.padEnd(30)} ${String(report.rendered).padStart(5)}/${String(report.items).padEnd(5)} ${coverage.padStart(5)}%${extras ? ` (${extras})` : ''}`);
		for (const [key, count] of report.failureClasses) {
			globalFailures.set(key, (globalFailures.get(key) ?? 0) + count);
			console.log(`      [${key}] x${count}${report.failureSamples.length > 0 ? ` e.g. ${report.failureSamples[0]}` : ''}`);
		}
	}
}

console.log(`\nTOTAL: ${totals.rendered}/${totals.items} (${(totals.rendered / Math.max(1, totals.items) * 100).toFixed(1)}%): ${totals.geo} via geo, ${totals.sprites} via sprite fallback`);
console.log('Failure classes overall:');
for (const [key, count] of [...globalFailures].toSorted((left, right) => right[1] - left[1])) {
	console.log(`  ${String(count).padStart(6)}  ${key}`);
}
