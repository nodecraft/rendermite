/**
 * `@nodecraft/rendermite/hosted` is for pages using the free CDN, so like
 * `/pack` it must bundle for a browser without dragging in the renderer. Its
 * behaviour tests run against a fake CDN serving the real file shapes.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
	afterEach,
	describe,
	expect,
	it,
	vi,
} from 'vitest';

import {
	bareImports,
	bundleEntry,
	root,
	walkBuilt,
} from './entry-bundle.ts';
import {
	createHostedClient,
	defineItemElement,
	iconClass,
	iconUrl,
	stylesheetUrls,
} from '../src/hosted.ts';
import { itemClass } from '../src/output/stylesheet.ts';

import type { HostedItemRegistry } from '../src/hosted.ts';

const ALLOWED = new Set([
	'src/hosted.ts',
	'src/hosted/client.ts',
	'src/hosted/element.ts',
	'src/hosted/urls.ts',
	'src/output/css-contract.ts',
]);

const SIZE_BUDGET = 16 * 1024;

describe('the hosted entry', () => {
	it('reaches only its own modules and the shared class contract', async () => {
		const { modules, code } = await bundleEntry('src/hosted.ts');
		expect(modules.filter(id => !ALLOWED.has(id))).toStrictEqual([]);
		expect(bareImports(code)).toStrictEqual([]);
		expect(code).not.toMatch(/require\(|node:|from ['"]sharp|from ['"]lightningcss|from ['"]yauzl/);
		expect(code.length).toBeLessThan(SIZE_BUDGET);
	});

	it('is published in the export map', () => {
		const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
			exports: Record<string, { types: string; import: string; }>;
		};
		expect(manifest.exports['./hosted']).toStrictEqual({ types: './dist/hosted.d.ts', import: './dist/hosted.js' });
	});

	it.runIf(existsSync(path.join(root, 'dist/hosted.js')))('ships a built entry that reaches nothing else', () => {
		const { bare, bytes } = walkBuilt('dist/hosted.js');
		expect(bare).toStrictEqual([]);
		expect(bytes).toBeLessThan(SIZE_BUDGET * 2);
	});

	it('does nothing when defining the element outside a browser', () => {
		expect(() => defineItemElement()).not.toThrow();
	});
});

describe('defineItemElement on a page that already has the tag', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function registryWith(element: object) {
		const define = vi.fn();
		vi.stubGlobal('customElements', { get: (name: string) => (name === 'mc-item' ? element : undefined), define });
		return define;
	}

	it('warns when another library owns the name, instead of losing silently', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const define = registryWith(class {});
		defineItemElement();
		expect(define).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('<mc-item> is already defined'));
	});

	it('stays quiet when a second copy of this package defined it', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const ours = { [Symbol.for('@nodecraft/rendermite/item-element')]: true };
		const define = registryWith(ours);
		defineItemElement();
		expect(define).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});
});

describe('iconUrl', () => {
	it('uses the versioned layout for vanilla and the shared one for mods', () => {
		expect(iconUrl('minecraft:diamond_sword', { version: '1.21.8' }))
			.toBe('https://assets.rendermite.dev/icons/1.21.8/items/minecraft/diamond_sword.webp');
		expect(iconUrl('create:wrench', { version: '1.21.8', format: 'png' }))
			.toBe('https://assets.rendermite.dev/icons/modded/items/create/wrench.png');
	});

	it('defaults the namespace to minecraft', () => {
		expect(iconUrl('stone', { version: '26.3' })).toBe(iconUrl('minecraft:stone', { version: '26.3' }));
	});

	it('refuses a vanilla id without a version rather than guessing one', () => {
		expect(() => iconUrl('minecraft:stone')).toThrow(/versioned/);
		expect(() => iconUrl(':stone')).toThrow(/Not an item id/);
	});

	it('keeps the case of legacy CamelCase mod ids', () => {
		expect(iconUrl('IC2:itemToolWrench')).toBe('https://assets.rendermite.dev/icons/modded/items/IC2/itemToolWrench.webp');
	});
});

describe('stylesheetUrls', () => {
	it('always loads the vanilla sheet first, since mod sheets lack the base rules', () => {
		expect(stylesheetUrls({ version: '26.3', namespaces: ['create', 'minecraft', 'create'] })).toStrictEqual([
			'https://assets.rendermite.dev/icons/26.3/rc-minecraft-64.css',
			'https://assets.rendermite.dev/icons/modded/css/create.css',
		]);
	});
});

describe('iconClass', () => {
	it('names the same class the stylesheet generator selects', () => {
		const id = 'weird_mod:odd item.v2';
		const [, itemClassName] = iconClass(id).split(' ', 2);
		// The generator escapes "." for the selector; markup uses it as is.
		expect(itemClass(id).replaceAll('\\', '')).toBe(itemClassName);
	});

	it('adds variant classes', () => {
		expect(iconClass('crossbow', { enchanted: true, projectile: 'firework_rocket' }))
			.toBe('rc-item rc-minecraft_crossbow rc-enchanted rc-projectile-minecraft_firework_rocket');
		expect(iconClass('minecraft:iron_chestplate', { trim: 'minecraft:gold' }))
			.toBe('rc-item rc-minecraft_iron_chestplate rc-trim-minecraft_gold');
	});
});

const LEGACY_REGISTRY: HostedItemRegistry = {
	version: '1.12.2',
	enchantments: [],
	items: [
		{ id: 'minecraft:stone', displayName: 'Stone', stackSize: 64, numericId: 1 },
		{ id: 'minecraft:deadbush', displayName: 'Dead Bush', stackSize: 64, numericId: 32, iconId: 'dead_bush' },
		{
			id: 'minecraft:wool',
			displayName: 'Wool',
			stackSize: 64,
			numericId: 35,
			variants: [
				{ damage: 0, displayName: 'White Wool', iconId: 'white_wool' },
				{ damage: 1, displayName: 'Orange Wool', iconId: 'orange_wool' },
			],
		},
		{ id: 'minecraft:diamond_sword', displayName: 'Diamond Sword', stackSize: 1 },
	],
};

const MODERN_REGISTRY: HostedItemRegistry = {
	version: '26.3',
	enchantments: [],
	items: [{ id: 'minecraft:air', displayName: 'Air', stackSize: 64 }],
};

/** A fake CDN serving the real file shapes, counting requests per path. */
function fakeCdn(files: Record<string, unknown>) {
	const requests: string[] = [];
	const fetch = async (input: string | URL | Request) => {
		const url = new URL(String(input));
		requests.push(url.pathname);
		const body = files[url.pathname];
		if (body instanceof Error) {
			return new Response('nope', { status: 500 });
		}
		if (body === undefined) {
			return new Response('missing', { status: 404 });
		}
		return Response.json(body);
	};
	return { fetch: fetch as typeof globalThis.fetch, requests };
}

const CDN_FILES = {
	'/versions.json': { versions: ['26.3', '1.12.2'] },
	'/icons/modded/namespaces.json': ['create'],
	'/icons/1.12.2/items-1.12.2.json': LEGACY_REGISTRY,
	'/icons/26.3/items-26.3.json': MODERN_REGISTRY,
	'/icons/26.3/rc-minecraft-failures.json': [{ id: 'minecraft:air', error: 'No drawable geometry' }],
};

describe('createHostedClient', () => {
	it('resolves a pre-1.13 damage value to the icon that variant draws as', async () => {
		const client = createHostedClient(fakeCdn(CDN_FILES));
		const wool = await client.item('minecraft:wool', { version: '1.12.2', damage: 1 });
		expect(wool).toStrictEqual({
			id: 'minecraft:wool',
			url: 'https://assets.rendermite.dev/icons/1.12.2/items/minecraft/orange_wool.webp',
			className: 'rc-item rc-minecraft_orange_wool',
			version: '1.12.2',
			displayName: 'Orange Wool',
			stackSize: 64,
		});
		const white = await client.item('minecraft:wool', { version: '1.12.2' });
		expect(white?.displayName).toBe('White Wool');
		expect(await client.item('minecraft:wool', { version: '1.12.2', damage: 99 })).toBeUndefined();
	});

	it('ignores damage on items without variants, where it is durability', async () => {
		const client = createHostedClient(fakeCdn(CDN_FILES));
		const sword = await client.item('diamond_sword', { version: '1.12.2', damage: 50 });
		expect(sword?.url).toBe('https://assets.rendermite.dev/icons/1.12.2/items/minecraft/diamond_sword.webp');
	});

	it('follows an icon published under another name', async () => {
		const client = createHostedClient(fakeCdn(CDN_FILES));
		const deadBush = await client.item('minecraft:deadbush', { version: '1.12.2' });
		expect(deadBush?.url).toBe('https://assets.rendermite.dev/icons/1.12.2/items/minecraft/dead_bush.webp');
	});

	it('defaults to the latest version and reports a listed failure', async () => {
		const client = createHostedClient(fakeCdn(CDN_FILES));
		const air = await client.item('minecraft:air');
		expect(air?.version).toBe('26.3');
		expect(air?.failure).toBe('No drawable geometry');
	});

	it('treats a version without a failures file as having none', async () => {
		const client = createHostedClient(fakeCdn(CDN_FILES));
		expect(await client.failures('1.12.2')).toStrictEqual([]);
		const stone = await client.item('minecraft:stone', { version: '1.12.2' });
		expect(stone?.failure).toBeUndefined();
	});

	it('returns nothing for an id the version or the CDN does not have', async () => {
		const client = createHostedClient(fakeCdn(CDN_FILES));
		expect(await client.item('minecraft:netherite_ingot', { version: '1.12.2' })).toBeUndefined();
		expect(await client.item('notamod:thing')).toBeUndefined();
		expect(await client.item('create:wrench')).toStrictEqual({
			id: 'create:wrench',
			url: 'https://assets.rendermite.dev/icons/modded/items/create/wrench.webp',
			className: 'rc-item rc-create_wrench',
		});
	});

	it('fetches each file once across lookups', async () => {
		const cdn = fakeCdn(CDN_FILES);
		const client = createHostedClient(cdn);
		await Promise.all([
			client.item('minecraft:stone', { version: '1.12.2' }),
			client.item('minecraft:wool', { version: '1.12.2' }),
			client.item('minecraft:deadbush', { version: '1.12.2' }),
		]);
		expect(cdn.requests.toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
			'/icons/1.12.2/items-1.12.2.json',
			'/icons/1.12.2/rc-minecraft-failures.json',
		]);
	});

	it('retries a request that failed instead of caching the failure', async () => {
		const files: Record<string, unknown> = { ...CDN_FILES, '/versions.json': new Error('down') };
		const client = createHostedClient(fakeCdn(files));
		await expect(client.latestVersion()).rejects.toThrow(/answered 500/);
		files['/versions.json'] = CDN_FILES['/versions.json'];
		await expect(client.latestVersion()).resolves.toBe('26.3');
	});
});
