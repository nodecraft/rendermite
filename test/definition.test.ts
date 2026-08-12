import { describe, expect, it } from 'vitest';

import {
	InvalidItemDefinitionError,
	UNKNOWN_MODEL,
	defaultProperties,
	evaluateItemModel,
} from '../src/items/definition.ts';

describe('evaluateItemModel', () => {
	it('resolves a plain model node', () => {
		const result = evaluateItemModel({ type: 'minecraft:model', model: 'minecraft:block/stone' });
		expect(result).toHaveLength(1);
		expect(result[0].model).toBe('minecraft:block/stone');
	});

	it('accepts unprefixed types', () => {
		expect(evaluateItemModel({ type: 'model', model: 'a:b' })[0].model).toBe('a:b');
	});

	it('flattens composites in order', () => {
		const result = evaluateItemModel({
			type: 'minecraft:composite',
			models: [
				{ type: 'minecraft:model', model: 'a:one' },
				{ type: 'minecraft:model', model: 'a:two' },
			],
		});
		expect(result.map(entry => entry.model)).toEqual(['a:one', 'a:two']);
	});

	it('takes the false branch of conditions by default, view_entity excepted', () => {
		const definition = (property: string) => {
			return {
				type: 'minecraft:condition',
				property,
				on_true: { type: 'minecraft:model', model: 'a:true' },
				on_false: { type: 'minecraft:model', model: 'a:false' },
			};
		};
		expect(evaluateItemModel(definition('minecraft:using_item'))[0].model).toBe('a:false');
		expect(evaluateItemModel(definition('minecraft:view_entity'))[0].model).toBe('a:true');
	});

	it('selects by string property with gui display context default', () => {
		const result = evaluateItemModel({
			type: 'minecraft:select',
			property: 'minecraft:display_context',
			cases: [
				{ when: ['gui', 'fixed'], model: { type: 'minecraft:model', model: 'a:gui' } },
			],
			fallback: { type: 'minecraft:model', model: 'a:other' },
		});
		expect(result[0].model).toBe('a:gui');
	});

	it('falls back to renderchest unknown when select matches nothing and has no fallback', () => {
		const result = evaluateItemModel({
			type: 'minecraft:select',
			property: 'minecraft:charge_type',
			cases: [{ when: 'rocket', model: { type: 'minecraft:model', model: 'a:rocket' } }],
		});
		expect(result[0].model).toBe(UNKNOWN_MODEL);
	});

	it('honours injected properties (crossbow charge_type)', () => {
		const properties = defaultProperties();
		properties.strings.set('minecraft:charge_type', 'rocket');
		const result = evaluateItemModel({
			type: 'minecraft:select',
			property: 'minecraft:charge_type',
			cases: [{ when: 'rocket', model: { type: 'minecraft:model', model: 'a:rocket' } }],
		}, properties);
		expect(result[0].model).toBe('a:rocket');
	});

	it('range_dispatch picks the first entry with threshold <= value (upstream order)', () => {
		const result = evaluateItemModel({
			type: 'minecraft:range_dispatch',
			property: 'minecraft:damage',
			entries: [
				{ threshold: 0, model: { type: 'minecraft:model', model: 'a:zero' } },
				{ threshold: 0.5, model: { type: 'minecraft:model', model: 'a:half' } },
			],
		});
		expect(result[0].model).toBe('a:zero');
	});

	it('renders empty/special/bundle as transparent', () => {
		expect(evaluateItemModel({ type: 'minecraft:empty' })).toEqual([]);
		expect(evaluateItemModel({ type: 'minecraft:special', model: {} })).toEqual([]);
		expect(evaluateItemModel({ type: 'minecraft:bundle/selected_item' })).toEqual([]);
	});

	it('throws on unknown types', () => {
		expect(() => evaluateItemModel({ type: 'modmod:custom' })).toThrow(InvalidItemDefinitionError);
	});

	it('accumulates transformations down the tree', () => {
		const result = evaluateItemModel({
			type: 'minecraft:composite',
			transformation: { scale: [2, 2, 2] },
			models: [{ type: 'minecraft:model', model: 'a:b', transformation: { translation: [1, 0, 0] } }],
		});
		const matrix = result[0].transform;
		// scale then translation: composed matrix scales by 2 and translates x by 2.
		expect(matrix[0]).toBe(2);
		expect(matrix[12]).toBe(2);
	});
});
