/**
 * Unredacted diagnosis for specific items, and optionally a PNG to look at:
 *
 *   node scripts/coverage/probe.ts lootr:lootr_shulker
 *   node scripts/coverage/probe.ts --png lootr:lootr_shulker
 *
 * Renders exactly as survey.ts does, dependency closure and all, so a failure
 * here is the same failure the sweep reported.
 *
 * `--png` writes through `encodeIcon`. Never hand a FloatTexture to sharp
 * directly: `data` is a Float64Array normalized [0,1], and read as raw bytes it
 * produces washed-out garbage for every item. That mistake cost a wrong
 * conclusion once — see docs/research/mod-coverage-campaign.md.
 */
import fs from 'node:fs';
import path from 'node:path';

import { eraFor, jarPath, readCatalog } from './corpus.ts';
import { builtinPackPath } from '../../src/builtin.ts';
import { prepareModResources } from '../../src/mods/prepare.ts';
import { encodeIcon } from '../../src/output/encode.ts';
import { ItemPipeline } from '../../src/render/pipeline.ts';
import { JarResourceManager } from '../../src/resources/jar.ts';
import { ResourceLocator } from '../../src/resources/locator.ts';
import { ensureVanillaJar } from '../../test/fixtures/index.ts';

const args = process.argv.slice(2);
const wantPng = args[0] === '--png';
const ids = wantPng ? args.slice(1) : args;
if (ids.length === 0) {
	throw new Error('usage: probe.ts [--png] <namespace:item> …');
}

const catalog = readCatalog();
/** The catalogued mod whose jar declares this namespace, by slug convention. */
function slugFor(namespace: string): string | null {
	const direct = Object.keys(catalog).find(slug => slug.replaceAll('-', '_') === namespace || slug === namespace);
	return direct ?? Object.keys(catalog).find(slug => namespace.startsWith(slug.replaceAll('-', '_'))) ?? null;
}

const out = path.join(import.meta.dirname, '..', '..', '.work', 'coverage', 'probe');
for (const id of ids) {
	const locator = ResourceLocator.parse(id);
	const slug = slugFor(locator.namespace);
	const game = slug === null ? undefined : catalog[slug]?.game;
	if (slug === null || game === undefined) {
		console.log(`${id} -> no catalogued jar for namespace ${locator.namespace}`);
		continue;
	}
	const preparation = await prepareModResources({
		jars: [jarPath(slug)],
		vanilla: new JarResourceManager(await ensureVanillaJar(game)),
	});
	const pipeline = await ItemPipeline.create(preparation.resources, {
		size: wantPng ? 128 : 16,
		quality: wantPng ? 2 : 1,
		lightingProfile: 'modern',
		builtin: builtinPackPath(eraFor(game)),
		// Nothing is written; the survey only cares whether a render succeeds.
		output: '',
		format: 'webp',
	});
	try {
		const frames = await pipeline.renderFramesWithFallback(id);
		if (wantPng) {
			fs.mkdirSync(out, { recursive: true });
			const file = path.join(out, `${id.replace(':', '_')}.png`);
			const encoded = await encodeIcon(frames.frames[0]);
			fs.writeFileSync(file, encoded.png);
			console.log(`${id} -> ok, wrote ${file}`);
		} else {
			console.log(`${id} -> ok`);
		}
	} catch (err) {
		console.log(`${id} -> ${(err as Error).message}`);
	}
}
