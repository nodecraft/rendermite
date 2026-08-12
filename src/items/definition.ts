/**
 * 1.21.4+ item-definition (`assets/<ns>/items/*.json`) evaluation for a static
 * GUI icon, mirroring upstream's Item classes and property defaults
 * (docs/research/renderchest-spec.md §3).
 */

import { fromItemTransform, identity, multiply } from '../render/vector.ts';

import type { Mat4 } from '../render/vector.ts';

export class InvalidItemDefinitionError extends Error {}

/** One model to render; a definition may yield several (composite), blended in order. */
export interface ItemRenderInstruction {
	model: string;
	tints: TintDefinition[];
	transform: Mat4;
}

export interface TintDefinition {
	type: string;
	[key: string]: unknown;
}

interface ItemNode {
	type?: string;
	transformation?: unknown;
	[key: string]: unknown;
}

/**
 * Property values renderchest assumes when rendering a static gui icon.
 * Conditions are false except view_entity; numbers 0; strings per table.
 */
export const CONDITION_DEFAULTS: Record<string, boolean> = {
	'minecraft:view_entity': true,
};

export const STRING_DEFAULTS: Record<string, string> = {
	'minecraft:main_hand': 'right',
	'minecraft:charge_type': 'none',
	'minecraft:trim_material': 'none',
	'minecraft:block_state': '',
	'minecraft:display_context': 'gui',
	'minecraft:local_time': '',
	'minecraft:context_dimension': 'minecraft:overworld',
	'minecraft:context_entity_type': 'minecraft:player',
};

export interface ItemProperties {
	conditions: Map<string, boolean>;
	strings: Map<string, string>;
	numbers: Map<string, number>;
}

export function defaultProperties(): ItemProperties {
	return { conditions: new Map(), strings: new Map(), numbers: new Map() };
}

function normalizeKey(property: string): string {
	return property.includes(':') ? property : `minecraft:${property}`;
}

function conditionValue(properties: ItemProperties, property: string): boolean {
	const key = normalizeKey(property);
	return properties.conditions.get(key) ?? CONDITION_DEFAULTS[key] ?? false;
}

function stringValue(properties: ItemProperties, property: string): string {
	const key = normalizeKey(property);
	return properties.strings.get(key) ?? STRING_DEFAULTS[key] ?? '';
}

function numberValue(properties: ItemProperties, property: string): number {
	const key = normalizeKey(property);
	return properties.numbers.get(key) ?? 0;
}

/** Model locator upstream falls back to when select/range_dispatch have no fallback. */
export const UNKNOWN_MODEL = 'renderchest:item/unknown';

function selectPropertyValue(properties: ItemProperties, property: string): string | number | boolean {
	const key = normalizeKey(property);
	if (properties.numbers.has(key)) {
		return properties.numbers.get(key) ?? 0;
	}
	if (properties.conditions.has(key)) {
		return properties.conditions.get(key) ?? false;
	}
	// local_time (the only dynamic property) falls through to its '' default, so
	// definitions selecting on it hit their fallback for static icons.
	return stringValue(properties, property);
}

/**
 * Evaluate a definition's `model` node into the flat list of models to render,
 * in composite order. An empty list means a fully transparent icon.
 */
export function evaluateItemModel(
	node: unknown,
	properties: ItemProperties = defaultProperties(),
	parentTransform: Mat4 = identity(),
): ItemRenderInstruction[] {
	if (typeof node !== 'object' || node === null) {
		throw new InvalidItemDefinitionError('Item model node is not an object');
	}
	const item = node as ItemNode;
	const transform = item.transformation === undefined
		? parentTransform
		: multiply(parentTransform, fromItemTransform(item.transformation));
	const type = normalizeKey(typeof item.type === 'string' ? item.type : '');

	switch (type) {
		case 'minecraft:model': {
			if (typeof item.model !== 'string') {
				throw new InvalidItemDefinitionError('minecraft:model without a model locator');
			}
			const tints = Array.isArray(item.tints) ? item.tints as TintDefinition[] : [];
			return [{ model: item.model, tints, transform }];
		}
		case 'minecraft:composite': {
			const models = Array.isArray(item.models) ? item.models : [];
			return models.flatMap(child => evaluateItemModel(child, properties, transform));
		}
		case 'minecraft:condition': {
			if (typeof item.property !== 'string' || item.on_true === undefined || item.on_false === undefined) {
				throw new InvalidItemDefinitionError('minecraft:condition missing property/on_true/on_false');
			}
			const branch = conditionValue(properties, item.property) ? item.on_true : item.on_false;
			return evaluateItemModel(branch, properties, transform);
		}
		case 'minecraft:select': {
			if (typeof item.property !== 'string') {
				throw new InvalidItemDefinitionError('minecraft:select missing property');
			}
			const value = selectPropertyValue(properties, item.property);
			const cases = Array.isArray(item.cases) ? item.cases : [];
			for (const entry of cases as Array<{ when: unknown; model: unknown; }>) {
				const when = Array.isArray(entry.when) ? entry.when : [entry.when];
				// Loose equality mirrors upstream's non-strict in_array.
				// eslint-disable-next-line eqeqeq
				if (when.some(candidate => candidate == value)) {
					return evaluateItemModel(entry.model, properties, transform);
				}
			}
			if (item.fallback !== undefined) {
				return evaluateItemModel(item.fallback, properties, transform);
			}
			return [{ model: UNKNOWN_MODEL, tints: [], transform }];
		}
		case 'minecraft:range_dispatch': {
			if (typeof item.property !== 'string') {
				throw new InvalidItemDefinitionError('minecraft:range_dispatch missing property');
			}
			const scale = typeof item.scale === 'number' ? item.scale : 1;
			const value = numberValue(properties, item.property) * scale;
			const entries = Array.isArray(item.entries) ? item.entries : [];
			// Upstream takes the FIRST entry in file order with value >= threshold
			// (vanilla picks the largest threshold <= value; reproduce upstream).
			for (const entry of entries as Array<{ threshold?: number; model: unknown; }>) {
				if (value >= (entry.threshold ?? 0)) {
					return evaluateItemModel(entry.model, properties, transform);
				}
			}
			if (item.fallback !== undefined) {
				return evaluateItemModel(item.fallback, properties, transform);
			}
			return [{ model: UNKNOWN_MODEL, tints: [], transform }];
		}
		case 'minecraft:special': {
			// Upstream renders specials as fully transparent (the corpus ships
			// invisible bed icons for 1.21.4–1.21.11). The `base` model is the
			// item's own ground/fixed representation — render that instead, and
			// let builtin overrides shadow the definition where they exist.
			if (typeof item.base === 'string') {
				const tints = Array.isArray(item.tints) ? item.tints as TintDefinition[] : [];
				return [{ model: item.base, tints, transform }];
			}
			return [];
		}
		case 'minecraft:empty':
		case 'minecraft:bundle/selected_item': {
			return [];
		}
		default: {
			throw new InvalidItemDefinitionError(`Unknown item model type: ${String(item.type)}`);
		}
	}
}

