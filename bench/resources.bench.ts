/**
 * Asset-access benchmarks. Indexing a client jar and discovering its items is
 * pure startup cost paid before the first icon exists, and it is invisible in
 * per-item timings — a regression here shows up only as a slower run.
 *
 * Setup runs once per side, at collection time: Vitest does not run suite hooks
 * in benchmark mode, and reading from an unindexed manager would measure the
 * wrong thing.
 */

import { BENCH_VERSION } from './global-setup.ts';
import { prepareSides } from './sides.ts';
import { vanillaJar } from '../test/fixtures/index.ts';

const jar = vanillaJar(BENCH_VERSION);
const TEXTURES = [
	'minecraft:block/stone',
	'minecraft:block/dirt',
	'minecraft:item/apple',
	'minecraft:block/oak_planks',
] as const;

const sides = await prepareSides(async (subject) => {
	const indexed = new subject.JarResourceManager(jar);
	await indexed.listNamespaces();
	const locators = TEXTURES.map(id => subject.ResourceLocator.parse(id));
	for (const locator of locators) {
		if (!await indexed.getResource('texture', locator)) {
			throw new Error(`Benchmark texture ${locator} is missing from ${jar}`);
		}
	}

	return {
		index: async (): Promise<void> => {
			const zip = await subject.openZip(jar);
			await new Promise<void>((resolve, reject) => {
				zip.on('entry', () => zip.readEntry());
				zip.on('end', resolve);
				zip.on('error', reject);
				zip.readEntry();
			});
			zip.close();
		},
		discover: async (): Promise<void> => {
			const resources = new subject.JarResourceManager(jar);
			await subject.discoverItems(resources, 'minecraft');
			await resources.close();
		},
		read: async (): Promise<number> => {
			let bytes = 0;
			for (const locator of locators) {
				const texture = await indexed.getResource('texture', locator);
				bytes += texture?.length ?? 0;
			}
			return bytes;
		},
	};
});

sides.compare('resources', 'index a client jar', { time: 2000 }, async ({ index }) => {
	await index();
});

sides.compare('resources', 'discover a namespace, cold manager', { time: 2000 }, async ({ discover }) => {
	await discover();
});

sides.compare('resources', 'read four textures out of an indexed jar', { time: 1000 }, async ({ read }) => {
	if (await read() === 0) {
		throw new Error('benchmark read nothing');
	}
});
