/**
 * Worker-thread rendering must be an optimization only: same items, same bytes,
 * same failure taxonomy. A drifting second implementation is exactly the class
 * of bug the shared ItemPipeline exists to prevent, so the check is a byte
 * comparison of every written file, not a spot check.
 */

import {
	mkdtemp,
	readFile,
	readdir,
	rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import { ensureVanillaJar } from './fixtures/index.ts';
import { fixtureModJar } from './fixtures/mods.ts';
import { builtinPackPath } from '../src/builtin.ts';
import { describeResources, restoreResources } from '../src/resources/descriptor.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { FolderResourceManager, LayeredResourceManager } from '../src/resources/manager.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { run } from '../src/run.ts';

import type { ResourceManager } from '../src/resources/manager.ts';
import type { RunResult } from '../src/run.ts';

function sorted(values: string[]): string[] {
	return values.toSorted((left, right) => left.localeCompare(right));
}

async function readTree(root: string): Promise<Map<string, Buffer>> {
	const files = new Map<string, Buffer>();
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) {
			continue;
		}

		const full = path.join(entry.parentPath, entry.name);
		files.set(path.relative(root, full).replaceAll('\\', '/'), await readFile(full));
	}
	return files;
}

describe('resource descriptors', () => {
	it('round-trips every describable manager', async () => {
		const map = new MapResourceManager().set('model', 'test:item/thing', '{"parent":"item/generated"}');
		const tree = new LayeredResourceManager([
			map,
			new FolderResourceManager(builtinPackPath('modern')),
			new JarResourceManager(fixtureModJar('depcore')),
		]);
		const descriptor = describeResources(tree);
		expect(descriptor).not.toBeNull();
		const restored = restoreResources(descriptor!);
		const restoredModels = await restored.listResources('model', 'test');
		const originalModels = await map.listResources('model', 'test');
		expect(await restored.getResource('model', restoredModels[0]))
			.toEqual(await map.getResource('model', originalModels[0]));
		expect(await restored.listNamespaces()).toEqual(await tree.listNamespaces());
	});

	it('describes a tree containing a foreign manager as null, so the run stays in-process', () => {
		const foreign: ResourceManager = {
			getResource: async () => null,
			getAllResources: async () => [],
			hasResource: async () => false,
			listResources: async () => [],
			listNamespaces: async () => [],
		};
		expect(describeResources(foreign)).toBeNull();
		expect(describeResources(new LayeredResourceManager([new MapResourceManager(), foreign]))).toBeNull();
	});
});

describe('worker rendering matches in-process rendering', () => {
	let serial: RunResult;
	let parallel: RunResult;
	let serialFiles: Map<string, Buffer>;
	let parallelFiles: Map<string, Buffer>;
	const outputs: string[] = [];

	beforeAll(async () => {
		const vanilla = await ensureVanillaJar('1.20.4');
		const resources = (): ResourceManager => new LayeredResourceManager([
			new JarResourceManager(fixtureModJar('loadermod')),
			new JarResourceManager(fixtureModJar('depcore')),
			new JarResourceManager(vanilla),
		]);
		const render = async (workers: number): Promise<[RunResult, Map<string, Buffer>]> => {
			const output = await mkdtemp(path.join(tmpdir(), `rendermite-workers-${workers}-`));
			outputs.push(output);
			const result = await run({
				resources: resources(),
				builtin: builtinPackPath('modern'),
				output,
				namespaces: ['loadermod'],
				size: 64,
				quality: 2,
				workers,
				itemList: true,
			});
			return [result, await readTree(output)];
		};
		[serial, serialFiles] = await render(1);
		[parallel, parallelFiles] = await render(4);
	}, 600000);

	afterAll(async () => {
		await Promise.all(outputs.map(output => rm(output, { recursive: true, force: true })));
	});

	it('spawns more than one worker when the run is big enough', () => {
		expect(serial.workers).toBe(1);
		expect(parallel.workers).toBeGreaterThan(1);
	});

	it('renders the same items, fallbacks and failures', () => {
		expect(parallel.rendered).toEqual(serial.rendered);
		expect(parallel.failed).toEqual(serial.failed);
		expect(sorted(parallel.spriteFallbacks)).toEqual(sorted(serial.spriteFallbacks));
		expect(sorted(parallel.skippedTemplates)).toEqual(sorted(serial.skippedTemplates));
		expect(parallel.writtenFiles).toBe(serial.writtenFiles);
	});

	it('writes byte-identical files', () => {
		expect(sorted(parallelFiles.keys().toArray())).toEqual(sorted(serialFiles.keys().toArray()));
		for (const [name, bytes] of serialFiles) {
			expect(parallelFiles.get(name), name).toEqual(bytes);
		}
	});
});
