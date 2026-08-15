/**
 * Renders every item of every catalogued mod and buckets the failures:
 *
 *   node scripts/coverage/survey.ts               # whole corpus
 *   node scripts/coverage/survey.ts create ae2    # named mods
 *
 * Each mod is surveyed with its dependency closure loaded but only its OWN
 * namespaces scored, so a dependency resolves references without having its
 * items counted against the mod under test. Run several processes over slices
 * of the catalog for wall-clock; nothing here writes shared state.
 */
import fs from 'node:fs';

import {
	DEPENDENCY_PATH,
	eraFor,
	jarPath,
	readCatalog,
	readJson,
} from './corpus.ts';
import { builtinPackPath } from '../../src/builtin.ts';
import { discoverItems } from '../../src/items/discovery.ts';
import { LOADER_NAMESPACES, prepareModResources } from '../../src/mods/prepare.ts';
import { ItemPipeline } from '../../src/render/pipeline.ts';
import { JarResourceManager } from '../../src/resources/jar.ts';
import { ensureVanillaJar } from '../../test/fixtures/index.ts';

import type { DependencyIndex } from './dependencies.ts';

const catalog = readCatalog();
const index = readJson<DependencyIndex>(DEPENDENCY_PATH, { provides: {}, needs: {} });

/** Transitive dependency jars for a slug, matching its game version. */
function closure(slug: string): string[] {
	const want = catalog[slug]?.game;
	const seen = new Set([slug]);
	const queue = [slug];
	const jars: string[] = [];
	while (queue.length > 0) {
		const current = queue.shift();
		for (const id of (current === undefined ? [] : index.needs[current]) ?? []) {
			const providers = index.provides[id] ?? [];
			// A 1.20.1 addon paired with its dependency's 1.21.1 build resolves
			// nothing, so an exact game-version match comes before any fallback.
			const pick = providers.find(candidate => catalog[candidate]?.game === want) ?? providers[0];
			if (pick === undefined || seen.has(pick)) {
				continue;
			}
			seen.add(pick);
			queue.push(pick);
			jars.push(jarPath(pick));
		}
	}
	return jars.filter(jar => fs.existsSync(jar));
}

const slugs = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(catalog);
/** Failure counts per message, with a sample of ids — the full list of a
 * 100k-item corpus's failures is not worth holding in memory. */
const buckets = new Map<string, { count: number; sample: string[]; }>();
const SAMPLE_IDS = 12;
let grandTotal = 0;
let grandFailed = 0;

/**
 * One vanilla tree per game version. Opening a fresh one per mod leaked a
 * descriptor and a full entry index of the client jar every iteration.
 */
const vanillaByGame = new Map<string, JarResourceManager>();
async function vanillaFor(game: string): Promise<JarResourceManager> {
	let manager = vanillaByGame.get(game);
	if (!manager) {
		manager = new JarResourceManager(await ensureVanillaJar(game));
		vanillaByGame.set(game, manager);
	}
	return manager;
}

for (const slug of slugs) {
	const own = jarPath(slug);
	const game = catalog[slug]?.game;
	if (game === undefined || !fs.existsSync(own)) {
		continue;
	}
	let preparation;
	let ownNamespaces: Set<string>;
	try {
		const solo = new JarResourceManager(own);
		const declared = await solo.listNamespaces();
		ownNamespaces = new Set(declared.filter(namespace => !LOADER_NAMESPACES.has(namespace)));
		await solo.close().catch(() => {});
		preparation = await prepareModResources({
			jars: [own, ...closure(slug)],
			vanilla: await vanillaFor(game),
		});
	} catch {
		continue;
	}
	const pipeline = await ItemPipeline.create(preparation.resources, {
		size: 16,
		quality: 1,
		lightingProfile: 'modern',
		builtin: builtinPackPath(eraFor(game)),
		// Nothing is written; the survey only cares whether a render succeeds.
		output: '',
		format: 'webp',
	});
	let total = 0;
	let failed = 0;
	const scored = preparation.namespaces.filter(candidate => ownNamespaces.has(candidate));
	for (const namespace of scored) {
		for (const item of await discoverItems(pipeline.resources, namespace)) {
			total++;
			try {
				await pipeline.renderFramesWithFallback(item.id);
			} catch (err) {
				failed++;
				// Ids are redacted so the same defect from 400 items aggregates.
				const key = (err as Error).message.replaceAll(/[\w.]+:[\w/.]+/g, '<id>');
				const bucket = buckets.get(key) ?? { count: 0, sample: [] };
				bucket.count++;
				if (bucket.sample.length < SAMPLE_IDS) {
					bucket.sample.push(item.id);
				}
				buckets.set(key, bucket);
			}
		}
	}
	// Every jar this opened stays open otherwise; over a few hundred mods that
	// is what turns a survey into an out-of-memory kill.
	await preparation.close();
	grandTotal += total;
	grandFailed += failed;
	if (failed > 0) {
		console.log(`${slug.padEnd(30)} ${game.padEnd(8)} ${String(total).padStart(5)} items ${String(failed).padStart(4)} failed`);
	}
}

await Promise.all(vanillaByGame.values().map(async manager => manager.close().catch(() => {})));

const rate = grandTotal === 0 ? 0 : (1 - grandFailed / grandTotal) * 100;
console.log(`\nTOTAL ${grandTotal} items, ${grandFailed} failed (${rate.toFixed(2)}%)`);
for (const [message, bucket] of [...buckets].toSorted((left, right) => right[1].count - left[1].count)) {
	console.log(`${String(bucket.count).padStart(5)}  ${message}\n       ${bucket.sample.join(', ')}`);
}
