import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { vanillaJar } from './fixtures/index.ts';
import { ModelLoader, resolveTexture, salvageJson } from '../src/models/loader.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { LayeredResourceManager } from '../src/resources/manager.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

import type { ResourceManager } from '../src/resources/manager.ts';

// Real 1.21.8 client assets, staged by `.work` setup (see DESIGN.md testing section).
const assetsJar = vanillaJar('1.21.8');
const hasFixture = existsSync(assetsJar);

describe.skipIf(!hasFixture)('ModelLoader against 1.21.8 assets', () => {
	const loader = new ModelLoader(new JarResourceManager(assetsJar));

	it('flattens a sprite item to builtin/generated', async () => {
		const model = await loader.load('minecraft:item/diamond_sword');
		expect(model.builtinParent).toBe('builtin/generated');
		expect(model.textures.layer0).toBe('minecraft:item/diamond_sword');
		expect(model.guiLight).toBe('front');
		expect(model.elements).toEqual([]);
		// handheld -> generated chain
		expect(model.chain).toContain('minecraft:item/handheld');
	});

	it('flattens a block item through the block model chain', async () => {
		// 1.21.4+ has no models/item/stone.json; its item definition points at the block model
		const model = await loader.load('minecraft:block/stone');
		expect(model.builtinParent).toBeNull();
		expect(model.elements.length).toBeGreaterThan(0);
		expect(model.guiLight).toBe('side');
		// cube_all binds #all; the item model inherits the block's resolution
		expect(resolveTexture(model, '#all')?.toString()).toBe('minecraft:block/stone');
		expect(model.display.gui?.rotation).toEqual([30, 225, 0]);
		expect(model.display.gui?.scale).toEqual([0.625, 0.625, 0.625]);
	});

	it('resolves chained texture references', async () => {
		const model = await loader.load('minecraft:block/cube_all');
		// #north -> #side -> #all (unbound at this level)
		expect(resolveTexture(model, '#north')).toBeNull();
		const stone = await loader.load('minecraft:block/stone');
		expect(resolveTexture(stone, '#north')?.toString()).toBe('minecraft:block/stone');
	});

	it('resolves Forge generated-item parent aliases', async () => {
		const mod = new MapResourceManager()
			.set('model', 'example:item/layered', JSON.stringify({
				parent: 'forge:item/default',
				textures: { layer0: 'example:item/layered' },
			}))
			.set('model', 'example:item/tool', JSON.stringify({
				parent: 'forge:item/default-tool',
				textures: { layer0: 'example:item/tool' },
			}));
		const aliased = new ModelLoader(new LayeredResourceManager([mod, new JarResourceManager(assetsJar)]));

		const layered = await aliased.load('example:item/layered');
		expect(layered.builtinParent).toBe('builtin/generated');
		expect(layered.chain).toContain('minecraft:item/generated');

		const tool = await aliased.load('example:item/tool');
		expect(tool.builtinParent).toBe('builtin/generated');
		expect(tool.chain).toContain('minecraft:item/handheld');
	});
});

describe('salvageJson', () => {
	it('parses clean JSON', () => {
		expect(salvageJson('{"a": 1}')).toEqual({ a: 1 });
	});

	it('tolerates trailing junk after the closing brace', () => {
		expect(salvageJson('{"a": {"b": []}} garbage}}')).toEqual({ a: { b: [] } });
	});

	it('ignores braces inside strings', () => {
		expect(salvageJson('{"a": "}{"}extra')).toEqual({ a: '}{' });
	});

	it('returns null for truncated JSON', () => {
		expect(salvageJson('{"a": {"b": 1}')).toBeNull();
		expect(salvageJson('no json here')).toBeNull();
	});
});

describe('shared model parents', () => {
	it('parses and retains shared parent geometry only once', async () => {
		const resources = new MapResourceManager()
			.set('model', 'example:item/first', JSON.stringify({ parent: 'example:item/shared' }))
			.set('model', 'example:item/second', JSON.stringify({ parent: 'example:item/shared' }))
			.set('model', 'example:item/shared', JSON.stringify({
				parent: 'builtin/generated',
				textures: { layer0: 'example:item/shared' },
				elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {} }],
			}));
		let sharedReads = 0;
		const counting: ResourceManager = {
			getResource: async (kind, locator) => {
				if (kind === 'model' && locator.toString() === 'example:item/shared') {
					sharedReads++;
				}
				return resources.getResource(kind, locator);
			},
			hasResource: (kind, locator) => resources.hasResource(kind, locator),
			getAllResources: (kind, locator) => resources.getAllResources(kind, locator),
			listResources: (kind, namespace) => resources.listResources(kind, namespace),
			listNamespaces: () => resources.listNamespaces(),
		};
		const loader = new ModelLoader(counting);
		const first = await loader.load('example:item/first');
		const second = await loader.load('example:item/second');

		expect(sharedReads).toBe(1);
		expect(first.elements).toBe(second.elements);
	});
});
