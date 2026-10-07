/**
 * Tint definition → color resolution for static icons, mirroring upstream's
 * Tinter classes (docs/renderchest-spec.md §8).
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

/**
 * appeng.api.util.AEColor's dark/medium/bright variants, read out of the enum's
 * static initialiser in AE2 26.1.10. Every `ae2:color` tint names one of these
 * plus a variant, and nothing in the mod's assets states the values.
 */
const AE_COLORS: Record<string, [number, number, number]> = {
	white: [0xB4_B4_B4, 0xE0_E0_E0, 0xF9_F9_F9],
	light_gray: [0x7E_7E_7E, 0xA0_9F_A0, 0xC4_C4_C4],
	gray: [0x4F_4F_4F, 0x6C_6B_6C, 0x94_92_94],
	black: [0x13_13_13, 0x27_27_27, 0x3B_3B_3B],
	lime: [0x4E_C0_4E, 0x70_E2_59, 0xB3_F8_6D],
	yellow: [0xFF_CF_40, 0xFF_E3_59, 0xF4_FF_80],
	orange: [0xD9_78_2F, 0xEC_A2_3C, 0xF2_BA_49],
	brown: [0x6E_4A_12, 0x7E_5C_16, 0x8E_6E_1A],
	red: [0xAA_21_2B, 0xD7_3E_42, 0xF0_76_65],
	pink: [0xD8_6E_AA, 0xFF_99_BB, 0xFB_CA_D5],
	magenta: [0xC1_51_89, 0xD5_71_9C, 0xE6_9E_BF],
	purple: [0x6E_5C_B8, 0x91_5D_CD, 0xB0_6F_DD],
	blue: [0x33_7F_F0, 0x38_94_FF, 0x40_C1_FF],
	light_blue: [0x69_B9_FF, 0x70_D2_FF, 0x80_F7_FF],
	cyan: [0x22_B0_AE, 0x2F_CC_B7, 0x65_E8_C9],
	green: [0x07_9B_6B, 0x17_B8_6D, 0x32_D8_50],
	fluix: [0x5A_47_9E, 0x91_5D_CD, 0xE2_A3_E3],
};

const VARIANT_INDEX: Record<string, number> = { dark: 0, medium: 1, bright: 2 };

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
		case 'ae2:storage_cell_state': {
			// CellState.EMPTY.getStateColor() — a freshly crafted cell holds nothing.
			return parseTintValue(0x00_FF_00);
		}
		case 'ae2:portable_cell_color': {
			// DyedItemColor.getOrDefault(stack, defaultColor); an undyed cell takes
			// the default AEItems passes to every PortableCellItem.
			return parseTintValue(0x80_CF_FF);
		}
		case 'ae2:color': {
			// AE2 tints its cables and terminals from AEColor, whose three
			// brightness variants exist only in the enum's static initialiser.
			const named = String((definition as { color?: unknown; }).color ?? '');
			const palette = AE_COLORS[named];
			if (!palette) {
				throw new InvalidTinterDefinitionError(`Unknown ae2:color colour: ${named}`);
			}
			const variant = String((definition as { variant?: unknown; }).variant ?? 'medium');
			return parseTintValue(palette[VARIANT_INDEX[variant] ?? 1]);
		}
		default: {
			// Data-driven/modded tint sources use `default` as the static value to
			// show when their runtime property cannot be resolved. The namespace is
			// intentionally open-ended: loaders can register their own tint types,
			// and a supplied default is still enough to render an accurate icon.
			if (DEFAULT_READING_TYPES.has(type) || Object.hasOwn(definition, 'default')) {
				return parseTintValue(definition.default);
			}
			// A tint a mod computes in code with no stated default. It is a colour
			// multiplier over a sprite that exists either way, so an unresolved one
			// costs colour, not the icon — and the untinted render is still the
			// mod's own artwork. Items told apart *only* by tint (mystical
			// agriculture's augments all share one greyscale sprite) do come out
			// alike; that is the price of having icons for them at all.
			return null;
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
