/**
 * The loaders' `fluid_container` item model type — the 1.21.4+ definition form
 * of the bucket model. The fluid id reaches the renderer on the instruction,
 * since it is stated on the definition rather than anywhere in the model chain.
 */

import { describe, expect, it } from 'vitest';

import { defaultProperties, evaluateItemModel } from '../src/items/definition.ts';

function evaluate(node: unknown): ReturnType<typeof evaluateItemModel> {
	return evaluateItemModel(node, defaultProperties());
}

describe('fluid_container item models', () => {
	it('renders the vanilla bucket carrying the fluid to paint', () => {
		const [instruction] = evaluate({
			type: 'neoforge:fluid_container',
			fluid: 'enderio:fluid_hootch_still',
			textures: { base: 'minecraft:item/bucket', fluid: 'neoforge:item/mask/bucket_fluid_drip' },
		});
		expect(instruction.model).toBe('minecraft:item/bucket');
		expect(instruction.fluid).toBe('enderio:fluid_hootch_still');
	});

	it('accepts the forge-namespaced spelling too', () => {
		const [instruction] = evaluate({ type: 'forge:fluid_container', fluid: 'somemod:oil' });
		expect(instruction.fluid).toBe('somemod:oil');
	});

	it('leaves an empty bucket unpainted', () => {
		const [instruction] = evaluate({ type: 'neoforge:fluid_container', fluid: 'minecraft:empty' });
		expect(instruction.fluid).toBeUndefined();
		expect(instruction.model).toBe('minecraft:item/bucket');
	});
});

describe('item model types a mod wraps', () => {
	it('renders the model an unknown type still names', () => {
		// forbidden_arcanus:wand swaps the sprite for a charged variant at runtime;
		// the named model is what a freshly crafted one shows.
		const [instruction] = evaluate({
			type: 'forbidden_arcanus:wand',
			model: 'forbidden_arcanus:item/acacia_wand',
		});
		expect(instruction.model).toBe('forbidden_arcanus:item/acacia_wand');
	});

	it('falls back to base_model when the type names the model that way', () => {
		// ae2:memory_card_identity layers a hash sprite over base_model; the base
		// alone is what a blank card shows.
		const [instruction] = evaluate({
			type: 'ae2:memory_card_identity',
			base_model: 'ae2:item/memory_card_base',
			color_overlay_sprite: 'ae2:item/memory_card_hash',
		});
		expect(instruction.model).toBe('ae2:item/memory_card_base');
	});

	it('carries tints through a wrapped type', () => {
		const [instruction] = evaluate({
			type: 'somemod:fancy',
			model: 'somemod:item/thing',
			tints: [{ type: 'minecraft:constant', value: 255 }],
		});
		expect(instruction.tints).toHaveLength(1);
	});

	it('still fails an unknown type that names nothing to draw', () => {
		expect(() => evaluate({ type: 'somemod:opaque' })).toThrow(/Unknown item model type/);
	});
});
