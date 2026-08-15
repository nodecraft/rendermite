import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { vanillaJar } from './fixtures/index.ts';
import { ModelLoader, resolveTexture, salvageJson } from '../src/models/loader.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { LayeredResourceManager } from '../src/resources/manager.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

import type { ResolvedModel } from '../src/models/loader.ts';
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

describe('override-only models', () => {
	/** A legacy model that is nothing but an `overrides` list has no geometry of
	 * its own, so the state an inventory stack reads (every predicate 0) picks it. */
	function overrideOnly(): MapResourceManager {
		return new MapResourceManager()
			.set('model', 'example:item/sigil', JSON.stringify({
				overrides: [
					{ predicate: { 'example:active': 1 }, model: 'example:item/on' },
					{ predicate: { 'example:active': 0 }, model: 'example:item/off' },
				],
			}))
			.set('model', 'example:item/off', JSON.stringify({ parent: 'builtin/generated', textures: { layer0: 'example:item/off' } }))
			.set('model', 'example:item/on', JSON.stringify({ parent: 'builtin/generated', textures: { layer0: 'example:item/on' } }));
	}

	it('resolves to the override matching the default state', async () => {
		const resolved = await new ModelLoader(overrideOnly()).load('example:item/sigil');
		expect(resolved.textures.layer0).toBe('example:item/off');
	});

	it('redirects even when the empty model parents onto item/generated', async () => {
		// Refined Storage's configuration_card declares that parent and then no
		// layers at all, leaving the overrides as the only thing that can draw.
		const resources = overrideOnly()
			.set('model', 'minecraft:item/generated', JSON.stringify({ parent: 'builtin/generated' }))
			.set('model', 'example:item/sigil', JSON.stringify({
				parent: 'item/generated',
				overrides: [{ predicate: { 'example:active': 0 }, model: 'example:item/off' }],
			}));
		const resolved = await new ModelLoader(resources).load('example:item/sigil');
		expect(resolved.textures.layer0).toBe('example:item/off');
	});

	it('does not hang when an override names the model it sits in', async () => {
		// armourers_workshop:item/skin lists itself as its unloaded state. load()
		// hands back the in-flight promise for a key it is already resolving, so
		// redirecting through it made the model await itself forever.
		const resources = new MapResourceManager()
			.set('model', 'example:item/skin', JSON.stringify({
				parent: 'builtin/entity',
				overrides: [{ predicate: { 'example:loading': 0 }, model: 'example:item/skin' }],
			}));
		const settled = await Promise.race([
			new ModelLoader(resources).load('example:item/skin').then(() => 'settled', () => 'settled'),
			new Promise((resolve) => {
				setTimeout(() => resolve('hung'), 2000);
			}),
		]);
		expect(settled).toBe('settled');
	});

	it('leaves a model that has geometry of its own alone', async () => {
		const resources = overrideOnly().set('model', 'example:item/sigil', JSON.stringify({
			parent: 'builtin/generated',
			textures: { layer0: 'example:item/base' },
			overrides: [{ predicate: { 'example:active': 0 }, model: 'example:item/off' }],
		}));
		const resolved = await new ModelLoader(resources).load('example:item/sigil');
		expect(resolved.textures.layer0).toBe('example:item/base');
	});
});

describe('custom loaders wrapping OBJ geometry', () => {
	async function load(json: unknown): Promise<ResolvedModel> {
		const resources = new MapResourceManager().set('model', 'test:item/thing', JSON.stringify(json));
		return new ModelLoader(resources).load('test:item/thing');
	}

	it('recognises a mod loader that states the OBJ loader\'s own keys', async () => {
		// Mekanism's transmitter loader is not named `obj`, but points at one.
		const model = await load({
			loader: 'mekanism:transmitter',
			model: 'mekanism:models/block/transmitter_small.obj.mek',
			flip_v: true,
		});
		expect(model.obj?.model).toBe('mekanism:models/block/transmitter_small.obj.mek');
		expect(model.obj?.flipV).toBe(true);
	});

	it('narrows the transmitter OBJ to the unconnected state', async () => {
		// One OBJ holds every connection state; an item has no neighbours, so
		// drawing them all would give a spiked ball of overlapping sides.
		const model = await load({
			loader: 'mekanism:transmitter',
			model: 'mekanism:models/block/transmitter_small.obj.mek',
		});
		expect(model.obj?.objects).toEqual([
			'downNONE',
			'upNONE',
			'northNONE',
			'southNONE',
			'eastNONE',
			'westNONE',
		]);
	});

	it('leaves an unknown loader with no OBJ reference alone', async () => {
		const model = await load({ loader: 'somemod:widget', textures: { layer0: 'somemod:item/widget' } });
		expect(model.obj).toBeUndefined();
	});

	it('does not mistake a non-OBJ model reference for geometry', async () => {
		const model = await load({ loader: 'somemod:wrapper', model: 'somemod:block/inner' });
		expect(model.obj).toBeUndefined();
	});

	it('unwraps a whole model nested under a key the loader names', async () => {
		// architects_palette:wrapped holds the drawable model as `wrapped_model`.
		const resources = new MapResourceManager()
			.set('model', 'minecraft:block/stairs', JSON.stringify({ elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: {} }] }))
			.set('model', 'test:item/thing', JSON.stringify({
				loader: 'architects_palette:wrapped',
				wrapper_type: 'boards',
				wrapped_model: { parent: 'minecraft:block/stairs', textures: { top: 'test:block/boards' } },
			}));
		const model = await new ModelLoader(resources).load('test:item/thing');
		expect(model.chain).toContain('minecraft:block/stairs');
		expect(model.textures.top).toBe('test:block/boards');
	});

	it('does not mistake a display or texture map for a nested model', async () => {
		const model = await load({
			loader: 'somemod:widget',
			textures: { layer0: 'somemod:item/widget' },
			display: { gui: { scale: [1, 1, 1] } },
		});
		expect(model.textures.layer0).toBe('somemod:item/widget');
	});
});

describe('loader-provided parent models', () => {
	it('rebases the loaders\' own default models onto vanilla', async () => {
		// Blockbench writes `neoforge:block/default` into every block it exports,
		// and no jar we read contains it — the loader registers it at runtime.
		const resources = new MapResourceManager()
			.set('model', 'test:item/thing', JSON.stringify({ parent: 'neoforge:block/default' }))
			.set('model', 'minecraft:block/block', JSON.stringify({
				display: { gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
			}));
		const model = await new ModelLoader(resources).load('test:item/thing');
		expect(model.chain).toContain('minecraft:block/block');
		expect(model.display.gui).toBeDefined();
	});
});

describe('composed loader models', () => {
	it('merges a botania floating flower onto its island', async () => {
		const island = { elements: [{ from: [0, 0, 0], to: [16, 4, 16], faces: { up: { texture: '#grass' } } }], textures: { grass: 'botania:block/dirt' } };
		const flower = { elements: [{ from: [7, 4, 7], to: [9, 12, 9], faces: { north: { texture: '#petal' } } }], textures: { petal: 'botania:block/rose' } };
		const resources = new MapResourceManager()
			.set('model', 'test:item/floating', JSON.stringify({ loader: 'botania:floating_flower', flower: { parent: 'botania:block/rose_flower' } }))
			.set('model', 'botania:block/islands/island_grass', JSON.stringify(island))
			.set('model', 'botania:block/rose_flower', JSON.stringify(flower));
		const model = await new ModelLoader(resources).load('test:item/floating');
		expect(model.elements).toHaveLength(2);
		// Each merged model keeps its own textures, resolved before the merge so
		// two models cannot fight over the same `#name`.
		const bound = model.elements.flatMap(element => Object.values(element.faces).map(face => face?.texture));
		expect(bound).toContain('botania:block/dirt');
		expect(bound).toContain('botania:block/rose');
	});
});

describe('sprite loaders that skip layer0', () => {
	async function textures(json: unknown): Promise<Record<string, string>> {
		const resources = new MapResourceManager()
			.set('model', 'test:item/thing', JSON.stringify(json))
			.set('model', 'minecraft:item/generated', JSON.stringify({ parent: 'builtin/generated' }));
		const model = await new ModelLoader(resources).load('test:item/thing');
		return model.textures;
	}

	it('treats a lone `texture` as the sprite layer', async () => {
		// Tinkers' material loader tints this sprite per material; untinted beats
		// the "generated model without layers" failure it used to cause.
		const bound = await textures({
			loader: 'tconstruct:material',
			parent: 'minecraft:item/generated',
			textures: { texture: 'tconstruct:item/tool/pickadze/adze' },
		});
		expect(bound.layer0).toBe('tconstruct:item/tool/pickadze/adze');
	});

	it('never overwrites a layer0 the model already states', async () => {
		const bound = await textures({
			loader: 'somemod:thing',
			parent: 'minecraft:item/generated',
			textures: { texture: 'somemod:item/other', layer0: 'somemod:item/real' },
		});
		expect(bound.layer0).toBe('somemod:item/real');
	});

	it('stacks tinkers tool parts in declaration order, skipping broad variants', async () => {
		const bound = await textures({
			loader: 'tconstruct:tool',
			parent: 'forge:item/default',
			textures: {
				head: 'tconstruct:item/tool/broad_axe/blade',
				handle: 'tconstruct:item/tool/broad_axe/handle',
				large_head: 'tconstruct:item/tool/broad_axe/large/blade',
				particle: 'tconstruct:item/particle',
			},
		});
		expect(bound.layer0).toBe('tconstruct:item/tool/broad_axe/blade');
		expect(bound.layer1).toBe('tconstruct:item/tool/broad_axe/handle');
		expect(bound.layer2).toBeUndefined();
	});
});

describe('machine models assembled from a casing', () => {
	it('merges the named casing under overlay faces', async () => {
		// MI names its casing rather than inlining it, and states overlays as full
		// texture ids: "casing": "lv" ↔ machine_casing/lv.
		const resources = new MapResourceManager()
			.set('model', 'test:item/machine', JSON.stringify({
				loader: 'modern_industrialization:machine',
				casing: 'lv',
				default_overlays: {
					front: 'modern_industrialization:block/machines/furnace/overlay_front',
					side: 'modern_industrialization:block/machines/overlay_side',
					front_active: 'modern_industrialization:block/machines/furnace/overlay_front_active',
					output: 'modern_industrialization:block/overlays/output',
				},
			}))
			.set('model', 'modern_industrialization:machine_casing/lv', JSON.stringify({
				elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { north: { texture: '#all' } } }],
				textures: { all: 'modern_industrialization:block/basic_machine_hull' },
			}))
			.set('model', 'minecraft:block/block', JSON.stringify({ display: { gui: { rotation: [30, 225, 0] } } }));
		const model = await new ModelLoader(resources).load('test:item/machine');

		// The casing cube plus one overlay cube.
		expect(model.elements).toHaveLength(2);
		const overlay = model.elements.find(element => element.faces.north?.texture === '#front');
		expect(overlay).toBeDefined();
		expect(overlay?.faces.east?.texture).toBe('#side');
		// Running and auto-IO overlays are runtime state, not part of the icon.
		expect(JSON.stringify(model.elements)).not.toContain('front_active');
		expect(model.textures.output).toBeUndefined();
	});

	it('resolves a casing that imitates another block', async () => {
		const resources = new MapResourceManager()
			.set('model', 'test:item/casing', JSON.stringify({
				loader: 'modern_industrialization:use_block_model',
				block: 'modern_industrialization:basic_machine_hull',
			}))
			.set('model', 'modern_industrialization:block/basic_machine_hull', JSON.stringify({
				elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {} }],
			}));
		const model = await new ModelLoader(resources).load('test:item/casing');
		expect(model.chain).toContain('modern_industrialization:block/basic_machine_hull');
	});

	it('follows a loader that delegates to one other model', async () => {
		const resources = new MapResourceManager()
			.set('model', 'test:item/pipe', JSON.stringify({ loader: 'somemod:wrapper', delegate: 'somemod:block/pipe' }))
			.set('model', 'somemod:block/pipe', JSON.stringify({
				elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: {} }],
			}));
		const model = await new ModelLoader(resources).load('test:item/pipe');
		expect(model.chain).toContain('somemod:block/pipe');
	});
});

describe('barrels composed from part models', () => {
	it('merges the part shapes and rebinds their textures per tier', async () => {
		// Sophisticated Storage's parts all default to acacia and are rebound by
		// the tier that composes them; the tier's own textures are trim overlays,
		// so they have to land on the part geometry rather than a bare cube.
		const resources = new MapResourceManager()
			.set('model', 'test:item/gold_barrel', JSON.stringify({
				loader: 'sophisticatedstorage:barrel',
				parent: 'test:block/barrel',
				model_parts: { tier: { textures: { top: 'test:block/gold_top', side: 'test:block/gold_side' } } },
			}))
			.set('model', 'test:block/barrel', JSON.stringify({
				loader: 'sophisticatedstorage:barrel',
				partitioned_model_parts: { body: { model: 'test:block/barrel_part/base' } },
			}))
			.set('model', 'test:block/barrel_part/base', JSON.stringify({
				textures: { top: 'test:block/acacia_top', side: 'test:block/acacia_side' },
				elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#top' }, north: { texture: '#side' } } }],
			}))
			.set('model', 'minecraft:block/block', JSON.stringify({ display: { gui: { rotation: [30, 225, 0] } } }));
		const model = await new ModelLoader(resources).load('test:item/gold_barrel');

		expect(model.elements).toHaveLength(1);
		const bound = Object.values(model.elements[0].faces).map(face => face?.texture);
		expect(bound).toContain('test:block/gold_top');
		expect(bound).toContain('test:block/gold_side');
		// The root barrel model declares no parent, so the gui pose has to be added.
		expect(model.display.gui).toBeDefined();
	});
});
