/**
 * Loader caches are bounded because a full modded run walks thousands of
 * namespaces in one process. Bounding them is only safe if eviction is
 * invisible to callers, so these check both the policy and that a re-read after
 * eviction still returns the right bytes.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import {
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import { LruCache } from '../src/resources/cache.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { FolderResourceManager } from '../src/resources/manager.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { TextureLoader } from '../src/textures/loader.ts';

const fixtureRoot = path.join(import.meta.dirname, '.fixtures', 'cache-pack');

beforeAll(async () => {
	await mkdir(path.join(fixtureRoot, 'assets', 'minecraft', 'models', 'item'), { recursive: true });
	await writeFile(path.join(fixtureRoot, 'assets', 'minecraft', 'models', 'item', 'stone.json'), '{}');
});

describe('LruCache', () => {
	it('evicts the least recently used entry past the entry cap', () => {
		const cache = new LruCache<string, number>(2);
		cache.set('a', 1);
		cache.set('b', 2);
		expect(cache.get('a')).toBe(1);
		cache.set('c', 3);
		// 'b' was the least recently used, so it goes, not the older-but-touched 'a'.
		expect(cache.get('b')).toBeUndefined();
		expect(cache.get('a')).toBe(1);
		expect(cache.get('c')).toBe(3);
	});

	it('evicts by weight once settled, keeping at least one entry', () => {
		const cache = new LruCache<string, { size: number; }>(100, {
			maxWeight: 10,
			weigh: value => value.size,
		});
		for (const name of ['a', 'b', 'c']) {
			const value = { size: 6 };
			cache.set(name, value);
			cache.settle(name, value);
		}
		expect(cache.size).toBe(1);
		expect(cache.get('c')).toEqual({ size: 6 });
	});
});

describe('FolderResourceManager.hasResource', () => {
	it('answers without reading the file, and stays correct', async () => {
		const manager = new FolderResourceManager(fixtureRoot);
		expect(await manager.hasResource('model', ResourceLocator.parse('minecraft:item/stone'))).toBe(true);
		expect(await manager.hasResource('model', ResourceLocator.parse('minecraft:item/absent'))).toBe(false);
		// A directory is not a resource, whatever its name.
		expect(await manager.hasResource('raw', ResourceLocator.parse('minecraft:models'))).toBe(false);
	});
});

describe('TextureLoader cache bounds', () => {
	it('re-decodes evicted textures instead of losing them', async () => {
		const resources = new MapResourceManager();
		const colors: Array<[number, number, number]> = [[255, 0, 0], [0, 255, 0], [0, 0, 255]];
		for (const [index, color] of colors.entries()) {
			const pixels = Buffer.alloc(16 * 16 * 4);
			for (let offset = 0; offset < pixels.length; offset += 4) {
				pixels.set(color, offset);
				pixels[offset + 3] = 255;
			}
			resources.set('texture', `test:item/tex${index}`, await sharp(pixels, {
				raw: { width: 16, height: 16, channels: 4 },
			}).png().toBuffer());
		}
		// A budget below one texture forces an eviction on every load.
		const loader = new TextureLoader(resources, 16);
		const read = async (index: number): Promise<number[]> => {
			const texture = await loader.load(ResourceLocator.parse(`test:item/tex${index}`));
			return [...texture!.data.subarray(0, 3)];
		};
		expect(await read(0)).toEqual(colors[0]);
		expect(await read(1)).toEqual(colors[1]);
		expect(await read(2)).toEqual(colors[2]);
		expect(await read(0)).toEqual(colors[0]);
	});
});
