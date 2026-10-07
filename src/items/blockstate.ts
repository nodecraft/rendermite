/**
 * Block models for items the game draws through a block-entity item renderer.
 *
 * A `builtin/entity` item model carries no geometry, but for a BlockItem the
 * renderer usually still draws the block first — Mekanism's `MekanismISTER`
 * calls `getBlockModelShaper().getBlockModel(block.defaultBlockState())` and
 * only then adds its own extras. That model is stated in the mod's own
 * blockstate file, so resolving it is following the data rather than guessing at
 * a name: `mekanism:basic_energy_cube` names `mekanism:block/energy_cube/basic`,
 * which no same-name lookup would ever find.
 *
 * The one thing assets cannot state is which state is the *default*, since that
 * lives in the block's Java constructor. `scoreVariant` picks the variant the
 * game would almost always start from, and prefers an unrotated one so an icon
 * is never accidentally turned away from the camera.
 */

import {
	multiply,
	rotationX,
	rotationY,
	translation,
} from '../render/vector.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { Mat4 } from '../render/vector.ts';
import type { ResourceManager } from '../resources/manager.ts';

interface VariantJson {
	model: string;
	x?: number;
	y?: number;
}

interface BlockStateJson {
	variants?: Record<string, VariantJson | VariantJson[]>;
	multipart?: Array<{ when?: unknown; apply: VariantJson | VariantJson[]; }>;
}

export interface ResolvedBlockState {
	model: ResourceLocator;
	/** Blockstate rotations, in degrees; the item transform has to replay them. */
	xRotation: number;
	yRotation: number;
}

/**
 * Property values a block's default state overwhelmingly uses. Blocks declare
 * their own defaults in code, so this is the one inference here — but a facing
 * block defaults to north far more often than not, and a machine defaults to
 * idle rather than running.
 */
const DEFAULT_VALUES: Record<string, string> = {
	facing: 'north',
	active: 'false',
	lit: 'false',
	powered: 'false',
	open: 'false',
	half: 'lower',
	axis: 'y',
	waterlogged: 'false',
};

/** Higher is more likely to be the state the game shows for a fresh block. */
function scoreVariant(key: string, variant: VariantJson): number {
	let score = 0;
	if (key === '') {
		score += 4;
	}
	// A rotated variant would render the icon from an unintended side.
	if (!variant.x && !variant.y) {
		score += 2;
	}
	for (const pair of key.split(',')) {
		const [name, value] = pair.split('=', 2);
		if (name && DEFAULT_VALUES[name] === value) {
			score++;
		}
	}
	return score;
}

function firstOf(variant: VariantJson | VariantJson[]): VariantJson | null {
	// A weighted list is one random pick per block; the first is the canonical one.
	const entry = Array.isArray(variant) ? variant[0] : variant;
	return entry?.model ? entry : null;
}

/**
 * The block model an item's blockstate names for its default state, or null
 * when the item has no blockstate or it states nothing usable.
 */
export async function defaultBlockStateModel(
	resources: ResourceManager,
	id: string,
): Promise<ResolvedBlockState | null> {
	const locator = ResourceLocator.tryParse(id);
	if (!locator) {
		return null;
	}
	const raw = await resources.getResource('blockstate', locator);
	if (raw === null) {
		return null;
	}
	let json: BlockStateJson;
	try {
		json = JSON.parse(raw.toString('utf8')) as BlockStateJson;
	} catch {
		return null;
	}

	let best: VariantJson | null = null;
	let bestScore = -1;
	for (const [key, value] of Object.entries(json.variants ?? {})) {
		const variant = firstOf(value);
		if (!variant) {
			continue;
		}
		const score = scoreVariant(key, variant);
		if (score <= bestScore) {
			continue;
		}
		best = variant;
		bestScore = score;
	}
	// Multipart has no variants; the unconditional pieces are what always shows.
	if (!best) {
		for (const part of json.multipart ?? []) {
			if (part.when === undefined) {
				best = firstOf(part.apply);
				break;
			}
		}
	}
	if (!best) {
		return null;
	}
	const model = ResourceLocator.tryParse(best.model.includes(':') ? best.model : `${locator.namespace}:${best.model}`);
	return model === null ? null : { model, xRotation: best.x ?? 0, yRotation: best.y ?? 0 };
}

/**
 * The blockstate's own x/y rotation as an item transform. Vanilla applies these
 * about the block's centre, and the game bakes them into the model before the
 * display transform, so they compose the same way here.
 */
export function blockStateTransform(state: ResolvedBlockState): Mat4 {
	const toRadians = Math.PI / 180;
	let matrix = translation(0.5, 0.5, 0.5);
	matrix = multiply(matrix, rotationX(-state.xRotation * toRadians));
	matrix = multiply(matrix, rotationY(-state.yRotation * toRadians));
	return multiply(matrix, translation(-0.5, -0.5, -0.5));
}
