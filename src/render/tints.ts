/**
 * Tint definition → color resolution for static icons, mirroring upstream's
 * Tinter classes (docs/research/renderchest-spec.md §8).
 */

import { ResourceLocator } from '../resources/locator.ts';

import type { TintColor } from './face.ts';
import type { TintDefinition } from '../items/definition.ts';
import type { TextureLoader } from '../textures/loader.ts';

export class InvalidTinterDefinitionError extends Error {}

/** The 16 dye colors upstream's renderchest:random picks from. */
export const DYE_COLORS = [
	'#f9fffe',
	'#f9801d',
	'#c74ebd',
	'#3ab3da',
	'#fed83d',
	'#80c71f',
	'#f38baa',
	'#474f52',
	'#9d9d97',
	'#169c9c',
	'#8932b8',
	'#3c44aa',
	'#835432',
	'#5e7c16',
	'#b02e26',
	'#1d1d21',
] as const;

function hexColor(hex: string): TintColor {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16) / 255,
		g: Number.parseInt(hex.slice(3, 5), 16) / 255,
		b: Number.parseInt(hex.slice(5, 7), 16) / 255,
	};
}

/**
 * Upstream constant-tint parsing: null/-1 → no tint; int → ARGB packed
 * (alpha ignored for tinting — tintImage uses the pixel's own alpha);
 * [r,g,b] floats. Anything else throws.
 */
export function parseTintValue(value: unknown): TintColor | null {
	if (([null, undefined, -1] as unknown[]).includes(value)) {
		return null;
	}
	if (typeof value === 'number') {
		// Unsigned shifts: ARGB ints like 0xFFF9FFFE exceed 2^31 and would go
		// negative under JS's signed coercion.
		return {
			r: ((value >>> 16) & 0xFF) / 255,
			g: ((value >>> 8) & 0xFF) / 255,
			b: (value & 0xFF) / 255,
		};
	}
	if (Array.isArray(value) && value.length >= 3 && value.every(entry => typeof entry === 'number')) {
		return { r: value[0], g: value[1], b: value[2] };
	}
	throw new InvalidTinterDefinitionError(`Unparseable tint value: ${JSON.stringify(value)}`);
}

const DEFAULT_READING_TYPES = new Set([
	'minecraft:dye',
	'minecraft:firework',
	'minecraft:potion',
	'minecraft:map_color',
	'minecraft:team',
]);

export interface TintContext {
	textures: TextureLoader;
	/** Deterministic replacement for upstream's random dye pick, keyed per item. */
	randomIndex?: number;
}

export async function resolveTint(definition: TintDefinition, context: TintContext): Promise<TintColor | null> {
	const type = definition.type.includes(':') ? definition.type : `minecraft:${definition.type}`;
	switch (type) {
		case 'minecraft:constant': {
			return parseTintValue(definition.value);
		}
		case 'minecraft:custom_model_data': {
			return null;
		}
		case 'minecraft:grass': {
			// Vanilla GrassColor.get: x = 1 - temperature, y = 1 - downfall*temperature.
			// (Upstream renderchest has a parsing bug that discards the values and can
			// even sample magenta; we deliberately do it right instead.)
			const temperature = clamp01(typeof definition.temperature === 'number' ? definition.temperature : 0.5);
			const downfall = clamp01(typeof definition.downfall === 'number' ? definition.downfall : 1);
			return sampleColorMap(context.textures, 'minecraft:colormap/grass', 1 - temperature, 1 - downfall * temperature);
		}
		case 'renderchest:random': {
			const index = context.randomIndex ?? Math.floor(Math.random() * DYE_COLORS.length);
			return hexColor(DYE_COLORS[index % DYE_COLORS.length]);
		}
		default: {
			if (DEFAULT_READING_TYPES.has(type)) {
				return parseTintValue(definition.default);
			}
			throw new InvalidTinterDefinitionError(`Unknown tint type: ${definition.type}`);
		}
	}
}

export async function resolveTints(
	definitions: TintDefinition[],
	context: TintContext,
): Promise<Array<TintColor | null>> {
	const colors: Array<TintColor | null> = [];
	for (const definition of definitions) {
		colors.push(await resolveTint(definition, context));
	}
	return colors;
}

function clamp01(value: number): number {
	return value < 0 ? 0 : (Math.min(value, 1));
}

/** Sample coordinates are clamped into the map; a missing map falls back to magenta. */
async function sampleColorMap(
	textures: TextureLoader,
	locator: string,
	sampleX: number,
	sampleY: number,
): Promise<TintColor> {
	const texture = await textures.load(ResourceLocator.parse(locator));
	if (!texture) {
		return { r: 1, g: 0, b: 1 };
	}
	const x = Math.min(texture.width - 1, Math.max(0, Math.floor(sampleX * texture.width)));
	const y = Math.min(texture.height - 1, Math.max(0, Math.floor(sampleY * texture.height)));
	const offset = (y * texture.width + x) * 4;
	return {
		r: texture.data[offset] / 255,
		g: texture.data[offset + 1] / 255,
		b: texture.data[offset + 2] / 255,
	};
}
