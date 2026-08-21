/**
 * Flat item layer collection, against hand-built assets.
 *
 * What matters here is the *decision*: which items get an entry and which are left
 * for the block pack to draw. A block item silently gaining a flat entry would
 * make a consumer draw a sprite where the game draws a cube, and an item wrongly
 * left out disappears from the world entirely — so both directions are pinned.
 */
import { describe, expect, it } from 'vitest';

import { collectItemSprites } from '../src/blocks/item-sprites.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { TextureLoader } from '../src/textures/loader.ts';

import type { ResourceManager } from '../src/resources/manager.ts';

/** A 1x1 opaque PNG, enough for a texture the collector only has to resolve by name. */
const PIXEL = Buffer.from(
	'89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478' +
	'9c63f8ffff3f0005fe02fea735b0410000000049454e44ae426082',
	'hex',
);

interface Assets {
	/** `models/item/<name>.json` bodies, by un-namespaced name. */
	models?: Record<string, unknown>;
	/** `items/<name>.json` definition bodies, by un-namespaced name. */
	definitions?: Record<string, unknown>;
	/** Texture paths that exist, as `item/lead`. */
	textures?: string[];
}

function resourcesFor(assets: Assets): ResourceManager {
	const manager = new MapResourceManager();
	// The template every flat item's chain ends at; the loader keys `builtin/generated` off it
	manager.set('model', 'minecraft:item/generated', JSON.stringify({ parent: 'builtin/generated' }));
	manager.set('model', 'minecraft:block/cube_all', JSON.stringify({
		elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#all' } } }],
	}));
	for (const [name, body] of Object.entries(assets.models ?? {})) {
		manager.set('model', `minecraft:item/${name}`, JSON.stringify(body));
	}
	for (const [name, body] of Object.entries(assets.definitions ?? {})) {
		manager.set('itemDefinition', `minecraft:${name}`, JSON.stringify(body));
	}
	for (const path of assets.textures ?? []) {
		manager.set('texture', `minecraft:${path}`, PIXEL);
	}
	return manager;
}

async function collect(assets: Assets, itemIds: string[], blocks: string[] = []) {
	const resources = resourcesFor(assets);
	const textures = new TextureLoader(resources);
	return await collectItemSprites({
		resources,
		models: new ModelLoader(resources),
		textures,
		namespaces: ['minecraft'],
		blocks: new Set(blocks),
		itemIds,
	});
}

describe('flat items', () => {
	const lead = {
		models: { lead: { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/lead' } } },
		textures: ['item/lead'],
	};

	it('exports the layer sprite', async () => {
		const result = await collect(lead, ['minecraft:lead']);

		expect(result.items).toStrictEqual({
			'minecraft:lead': { layers: [{ sprite: 'minecraft:item/lead' }] },
		});
		expect([...result.spriteIds]).toStrictEqual(['minecraft:item/lead']);
		expect(result.failures).toStrictEqual([]);
	});

	/** The client stacks `layer0` under `layer1`; a reversed pair draws the overlay behind. */
	it('orders layers by their number, not by key order', async () => {
		const result = await collect({
			models: {
				potion: {
					parent: 'minecraft:item/generated',
					// Written back to front on purpose: a merged parent chain has no reliable order
					textures: { layer1: 'minecraft:item/potion', layer0: 'minecraft:item/potion_overlay' },
				},
			},
			textures: ['item/potion', 'item/potion_overlay'],
		}, ['minecraft:potion']);

		expect(result.items['minecraft:potion'].layers.map(layer => layer.sprite))
			.toStrictEqual(['minecraft:item/potion_overlay', 'minecraft:item/potion']);
	});

	it('reports a layer whose texture variable nothing binds, and keeps the rest', async () => {
		const result = await collect({
			models: {
				broken: {
					parent: 'minecraft:item/generated',
					textures: { layer0: 'minecraft:item/lead', layer1: '#nothing' },
				},
			},
			textures: ['item/lead'],
		}, ['minecraft:broken']);

		expect(result.items['minecraft:broken'].layers).toStrictEqual([{ sprite: 'minecraft:item/lead' }]);
		expect(result.failures).toHaveLength(1);
		expect(result.failures[0].reason).toContain('resolves to no texture');
	});

	it('drops a generated model with no layers at all', async () => {
		const result = await collect({ models: { empty: { parent: 'minecraft:item/generated' } } }, ['minecraft:empty']);

		expect(result.items).toStrictEqual({});
		expect(result.failures[0].reason).toContain('states no layers');
	});
});

describe('items the block pack draws instead', () => {
	const stone = {
		models: { stone: { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } } },
		textures: ['block/stone'],
	};

	/**
	 * The whole point of the split: a block item has no entry, so the consumer falls
	 * through to `blockstates.json` and draws the cube the game draws.
	 */
	it('leaves a block item out entirely', async () => {
		const result = await collect(stone, ['minecraft:stone'], ['minecraft:stone']);

		expect(result.items).toStrictEqual({});
		expect([...result.spriteIds]).toStrictEqual([]);
	});

	/** Said out loud only when nothing else can draw it — a block item is by design. */
	it('says nothing about a block item, and something about an orphan', async () => {
		const asBlock = await collect(stone, ['minecraft:stone'], ['minecraft:stone']);
		expect(asBlock.failures).toStrictEqual([]);

		const orphan = await collect(stone, ['minecraft:stone'], []);
		expect(orphan.failures).toHaveLength(1);
		expect(orphan.failures[0].reason).toContain('not a flat sprite stack');
	});

	it('reports an item with no model or definition at all', async () => {
		const result = await collect({}, ['minecraft:nonexistent']);

		expect(result.items).toStrictEqual({});
		expect(result.failures).toHaveLength(1);
	});
});

describe('tints', () => {
	/**
	 * `ItemModelGenerator` hands each layer its own index as the tint index, so a
	 * layer is tinted exactly when the definition declares one at that position —
	 * which is why the untinted second layer here must not be marked.
	 */
	it('marks the layer the definition tints, and carries a constant colour', async () => {
		const result = await collect({
			definitions: {
				leather_boots: {
					model: {
						type: 'minecraft:model',
						model: 'minecraft:item/leather_boots',
						tints: [{ type: 'minecraft:constant', value: 0xA0_65_40 }],
					},
				},
			},
			models: {
				leather_boots: {
					parent: 'minecraft:item/generated',
					textures: { layer0: 'minecraft:item/leather_boots', layer1: 'minecraft:item/leather_boots_overlay' },
				},
			},
			textures: ['item/leather_boots', 'item/leather_boots_overlay'],
		}, ['minecraft:leather_boots']);

		expect(result.items['minecraft:leather_boots'].layers).toStrictEqual([
			{ sprite: 'minecraft:item/leather_boots', tintindex: 0, tint: '#a06540' },
			{ sprite: 'minecraft:item/leather_boots_overlay' },
		]);
	});

	/**
	 * A tint whose colour lives in the stack's components — a dyed boot, a brewed
	 * potion — is marked tinted with no colour. The consumer then draws the mod's
	 * own artwork untinted, which is what the icon renderer settles for too.
	 */
	it('marks a tint it cannot resolve without saying a colour', async () => {
		const result = await collect({
			definitions: {
				firework_star: {
					model: {
						type: 'minecraft:model',
						model: 'minecraft:item/firework_star',
						tints: [{ type: 'minecraft:firework' }],
					},
				},
			},
			models: {
				firework_star: { parent: 'minecraft:item/generated', textures: { layer0: 'minecraft:item/firework_star' } },
			},
			textures: ['item/firework_star'],
		}, ['minecraft:firework_star']);

		expect(result.items['minecraft:firework_star'].layers).toStrictEqual([
			{ sprite: 'minecraft:item/firework_star', tintindex: 0 },
		]);
	});
});
