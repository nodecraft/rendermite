import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { vanillaJar } from './fixtures/index.ts';
import { ModelLoader, resolveTexture, salvageJson } from '../src/models/loader.ts';
import { JarResourceManager } from '../src/resources/jar.ts';

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
