import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import { CachedListingResourceManager } from '../src/resources/cached.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { FolderResourceManager, LayeredResourceManager } from '../src/resources/manager.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

const fixtureRoot = path.join(import.meta.dirname, '.fixtures', 'pack-a');
const overlayRoot = path.join(import.meta.dirname, '.fixtures', 'pack-b');

beforeAll(async () => {
	await mkdir(path.join(fixtureRoot, 'assets', 'minecraft', 'models', 'item'), { recursive: true });
	await mkdir(path.join(fixtureRoot, 'assets', 'minecraft', 'models', 'block'), { recursive: true });
	await mkdir(path.join(overlayRoot, 'assets', 'minecraft', 'models', 'item'), { recursive: true });
	await mkdir(path.join(overlayRoot, 'assets', 'examplemod', 'models', 'item'), { recursive: true });
	await writeFile(path.join(fixtureRoot, 'assets', 'minecraft', 'models', 'item', 'stone.json'), JSON.stringify({ from: 'a' }));
	await writeFile(path.join(fixtureRoot, 'assets', 'minecraft', 'models', 'block', 'stone.json'), JSON.stringify({ block: true }));
	await writeFile(path.join(overlayRoot, 'assets', 'minecraft', 'models', 'item', 'stone.json'), JSON.stringify({ from: 'b' }));
	await writeFile(path.join(overlayRoot, 'assets', 'examplemod', 'models', 'item', 'wrench.json'), JSON.stringify({ mod: true }));
});

describe('FolderResourceManager', () => {
	it('reads resources by kind and locator', async () => {
		const manager = new FolderResourceManager(fixtureRoot);
		const buf = await manager.getResource('model', ResourceLocator.parse('minecraft:item/stone'));
		expect(JSON.parse(buf!.toString())).toEqual({ from: 'a' });
	});

	it('returns null for missing resources', async () => {
		const manager = new FolderResourceManager(fixtureRoot);
		expect(await manager.getResource('model', ResourceLocator.parse('minecraft:item/missing'))).toBeNull();
	});

	it('lists resources recursively with directory-relative paths', async () => {
		const manager = new FolderResourceManager(fixtureRoot);
		const models = await manager.listResources('model', 'minecraft');
		const paths = models.map(String).toSorted((left, right) => left.localeCompare(right));
		expect(paths).toEqual(['minecraft:block/stone', 'minecraft:item/stone']);
	});

	it('lists namespaces', async () => {
		const manager = new FolderResourceManager(overlayRoot);
		const namespaces = await manager.listNamespaces();
		expect(namespaces.toSorted((left, right) => left.localeCompare(right))).toEqual(['examplemod', 'minecraft']);
	});
});

describe('LayeredResourceManager', () => {
	it('earlier layers win', async () => {
		const layered = new LayeredResourceManager([
			new FolderResourceManager(overlayRoot),
			new FolderResourceManager(fixtureRoot),
		]);
		const buf = await layered.getResource('model', ResourceLocator.parse('minecraft:item/stone'));
		expect(JSON.parse(buf!.toString())).toEqual({ from: 'b' });
	});

	it('merges lists and namespaces across layers', async () => {
		const layered = new LayeredResourceManager([
			new FolderResourceManager(overlayRoot),
			new FolderResourceManager(fixtureRoot),
		]);
		const models = await layered.listResources('model', 'minecraft');
		expect(models.map(String).toSorted((left, right) => left.localeCompare(right))).toEqual(['minecraft:block/stone', 'minecraft:item/stone']);
		expect(await layered.listNamespaces()).toEqual(['examplemod', 'minecraft']);
	});
});

describe('CachedListingResourceManager', () => {
	it('hands every caller its own copy of a listing', async () => {
		const inner = new MapResourceManager().set('texture', 'minecraft:block/stone', Buffer.from('png'));
		const cached = new CachedListingResourceManager(inner);
		const first = await cached.listResources('texture', 'minecraft');
		first.push(ResourceLocator.parse('minecraft:block/imaginary'));
		const second = await cached.listResources('texture', 'minecraft');
		expect(second.map(String)).toEqual(['minecraft:block/stone']);
	});

	it('retries a listing that failed rather than remembering the failure', async () => {
		class FlakyResourceManager extends MapResourceManager {
			private calls = 0;

			override async listResources(): Promise<ResourceLocator[]> {
				this.calls++;
				if (this.calls === 1) {
					throw new Error('transient');
				}
				return [ResourceLocator.parse('minecraft:block/stone')];
			}
		}
		const cached = new CachedListingResourceManager(new FlakyResourceManager());
		await expect(cached.listResources('texture', 'minecraft')).rejects.toThrow('transient');
		const retried = await cached.listResources('texture', 'minecraft');
		expect(retried.map(String)).toEqual(['minecraft:block/stone']);
	});
});
