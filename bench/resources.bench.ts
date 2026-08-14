/**
 * Asset-access benchmarks. Indexing a client jar and discovering its items is
 * pure startup cost paid before the first icon exists, and it is invisible in
 * per-item timings — a regression here shows up only as a slower run.
 */

import { bench, describe } from 'vitest';

import { BENCH_VERSION } from './global-setup.ts';
import { discoverItems } from '../src/items/discovery.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { openZip } from '../src/resources/zip-reader.ts';
import { vanillaJar } from '../test/fixtures/index.ts';

const jar = vanillaJar(BENCH_VERSION);

describe('resources', () => {
	bench('index a client jar', async () => {
		const zip = await openZip(jar);
		await new Promise<void>((resolve, reject) => {
			zip.on('entry', () => zip.readEntry());
			zip.on('end', resolve);
			zip.on('error', reject);
			zip.readEntry();
		});
		zip.close();
	}, { time: 2000 });

	bench('discover a namespace, cold manager', async () => {
		const resources = new JarResourceManager(jar);
		await discoverItems(resources, 'minecraft');
		await resources.close();
	}, { time: 2000 });
});

// Top-level, not beforeAll: Vitest does not run suite hooks in benchmark mode,
// and reading from an unindexed manager would measure the wrong thing.
const indexed = new JarResourceManager(jar);
await indexed.listNamespaces();
const locators = [
	'minecraft:block/stone',
	'minecraft:block/dirt',
	'minecraft:item/apple',
	'minecraft:block/oak_planks',
].map(id => ResourceLocator.parse(id));
for (const locator of locators) {
	if (!await indexed.getResource('texture', locator)) {
		throw new Error(`Benchmark texture ${locator} is missing from ${jar}`);
	}
}

describe('resources: reads', () => {
	bench('read four textures out of an indexed jar', async () => {
		let bytes = 0;
		for (const locator of locators) {
			const texture = await indexed.getResource('texture', locator);
			bytes += texture?.length ?? 0;
		}
		if (bytes === 0) {
			throw new Error('benchmark read nothing');
		}
	}, { time: 1000 });
});
