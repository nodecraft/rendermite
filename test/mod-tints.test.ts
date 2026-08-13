import { describe, expect, it } from 'vitest';

import { modTintPackPath } from '../src/builtin.ts';
import { defaultProperties } from '../src/items/definition.ts';
import { resolveItem } from '../src/items/discovery.ts';
import { curatedTintOverrides, harvestTintOverrides } from '../src/mods/tints.ts';
import { resolveTints } from '../src/render/tints.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { FolderResourceManager } from '../src/resources/manager.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

import type { TextureLoader } from '../src/textures/loader.ts';

const GENERATED = JSON.stringify({ parent: 'item/generated', textures: { layer0: 'testmod:item/thing' } });

function definition(model: unknown): string {
	return JSON.stringify({ model });
}

function modelNode(model: string, tints: unknown[]): unknown {
	return { type: 'minecraft:model', model, tints };
}

/** A donor release stating its tints as data, plus the older tree being rendered. */
function fixture(): { donors: MapResourceManager; target: MapResourceManager; } {
	const donors = new MapResourceManager();
	donors.set('itemDefinition', 'testmod:gizmo', definition(modelNode('testmod:item/gizmo_new', [{ type: 'minecraft:constant', value: -65536 }])));
	donors.set('itemDefinition', 'testmod:cell', definition(modelNode('testmod:item/cell', [{ type: 'ae2:color', color: 'fluix', variant: 'dark' }])));
	donors.set('itemDefinition', 'testmod:mixed', definition(modelNode('testmod:item/mixed', [
		{ type: 'ae2:color', color: 'fluix', variant: 'dark' },
		{ type: 'minecraft:constant', value: -16_776_961 },
	])));
	donors.set('itemDefinition', 'testmod:dyed', definition({
		type: 'minecraft:select',
		property: 'minecraft:trim_material',
		cases: [{ when: 'minecraft:iron', model: modelNode('testmod:item/dyed_iron_trim', [{ type: 'minecraft:dye', default: -6_265_536 }]) }],
		fallback: modelNode('testmod:item/dyed', [{ type: 'minecraft:dye', default: -6_265_536 }]),
	}));
	donors.set('itemDefinition', 'testmod:coded', definition({ type: 'testmod:quantum_armor', model: 'testmod:item/coded' }));
	donors.set('itemDefinition', 'testmod:layered', definition({
		type: 'minecraft:composite',
		models: [
			modelNode('testmod:item/layered_base', [{ type: 'minecraft:constant', value: -65536 }]),
			modelNode('testmod:item/layered_top', [{ type: 'minecraft:constant', value: -65536 }]),
		],
	}));
	donors.set('itemDefinition', 'testmod:absent', definition(modelNode('testmod:item/absent', [{ type: 'minecraft:constant', value: -65536 }])));
	donors.set('itemDefinition', 'testmod:own', definition(modelNode('testmod:item/own', [{ type: 'minecraft:constant', value: -65536 }])));

	const target = new MapResourceManager();
	for (const name of ['gizmo', 'cell', 'mixed', 'dyed', 'coded', 'layered', 'own']) {
		target.set('model', `testmod:item/${name}`, GENERATED);
	}
	// The mod's own definition for this one must outrank anything derived.
	target.set('itemDefinition', 'testmod:own', definition(modelNode('testmod:item/own', [])));
	return { donors, target };
}

async function harvestedTints(overrides: MapResourceManager, id: string): Promise<unknown> {
	const raw = await overrides.getResource('itemDefinition', ResourceLocator.parse(id));
	if (!raw) {
		return null;
	}
	return (JSON.parse(raw.toString('utf8')) as { model: { tints: unknown; }; }).model.tints;
}

describe('harvesting tints from a newer jar of the same mod', () => {
	it('binds a donor constant tint to the target\'s own item model', async () => {
		const { donors, target } = fixture();
		const { overrides, harvested } = await harvestTintOverrides({ donors, target });

		expect(harvested).toBeGreaterThan(0);
		const raw = await overrides.getResource('itemDefinition', ResourceLocator.parse('testmod:gizmo'));
		expect(JSON.parse(raw!.toString('utf8'))).toEqual({
			model: {
				type: 'minecraft:model',
				// Bound to the OLD tree's model, never the donor's (which may not exist here).
				model: 'testmod:item/gizmo',
				tints: [{ type: 'minecraft:constant', value: -65536 }],
			},
		});
	});

	it('reads the static gui branch of a select and keeps its default', async () => {
		const { donors, target } = fixture();
		const { overrides } = await harvestTintOverrides({ donors, target });
		expect(await harvestedTints(overrides, 'testmod:dyed')).toEqual([{ type: 'minecraft:dye', default: -6_265_536 }]);
	});

	it('holds runtime-only slots open so later tints keep their layer', async () => {
		const { donors, target } = fixture();
		const { overrides } = await harvestTintOverrides({ donors, target });
		expect(await harvestedTints(overrides, 'testmod:mixed')).toEqual([
			{ type: 'minecraft:constant', value: -1 },
			{ type: 'minecraft:constant', value: -16_776_961 },
		]);
	});

	it('harvests nothing when every tint needs runtime state', async () => {
		const { donors, target } = fixture();
		const { overrides } = await harvestTintOverrides({ donors, target });
		expect(await harvestedTints(overrides, 'testmod:cell')).toBeNull();
	});

	it('skips code-registered model types, composites, absent models, and self-declared items', async () => {
		const { donors, target } = fixture();
		const { overrides } = await harvestTintOverrides({ donors, target });
		for (const id of ['testmod:coded', 'testmod:layered', 'testmod:absent', 'testmod:own']) {
			expect(await harvestedTints(overrides, id)).toBeNull();
		}
	});
});

describe('curated tint overrides', () => {
	it('tints Advanced AE quantum armor layer 1 through the normal definition path', async () => {
		const resources = curatedTintOverrides();
		for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
			const instructions = await resolveItem(resources, `advanced_ae:quantum_${piece}`, defaultProperties());
			expect(instructions).toHaveLength(1);
			expect(instructions[0].model).toBe(`advanced_ae:item/quantum_${piece}`);
			// Colormap sampling is never reached by a constant tint.
			const tints = await resolveTints(instructions[0].tints, { textures: {} as TextureLoader });
			expect(tints).toEqual([
				null,
				{ r: 0x71 / 255, g: 0x10 / 255, b: 0xA5 / 255 },
			]);
		}
	});

	it('holds only item definitions, one namespace directory per mod', async () => {
		const pack = new FolderResourceManager(modTintPackPath());
		const namespaces = await pack.listNamespaces();
		expect(namespaces).toContain('advanced_ae');
		for (const namespace of namespaces) {
			const entries = await pack.listResources('itemDefinition', namespace);
			expect(entries.length).toBeGreaterThan(0);
		}
	});
});
