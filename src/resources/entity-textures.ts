/**
 * Finding a mod's own entity sheet for a thing the game draws in Java.
 *
 * A chest, a mob head, a bed or a shulker box carries no texture in its model,
 * and mods put theirs wherever they like: quark nests variant chests under
 * `quark_variant_chests/acacia/normal`, lootr files whole skins straight under
 * `textures/`. So the sheet is searched for by token overlap with the block or
 * item name rather than assumed from a path.
 *
 * Shared by the icon renderer's `builtin/entity` fallback and the block pack's
 * substitution table, which are the same problem seen from two directions.
 */

import { ResourceLocator } from './locator.ts';

import type { ResourceManager } from './manager.ts';
import type { TextureLoader } from '../textures/loader.ts';

/** Tokens too generic to identify a texture on their own. */
const FILLER_TOKENS = new Set(['chest', 'chests', 'crate', 'crates', 'trapped', 'big', 'small', 'the', 'of']);

/** Double-chest halves, lid states, boat sheets, seasonal skins — never icon textures. */
const SKIP_TOKENS = new Set(['left', 'right', 'open', 'opened', 'christmas', 'boat', 'raft', 'minecart']);

export function tokens(name: string): string[] {
	return name.split(/[./_]/).filter(token => token.length > 1);
}


/** Vanilla DyeColor diffuse colors, keyed by the dye name mods prefix with. */
export const DYE_COLORS: Record<string, number> = {
	white: 0xF9_FF_FE,
	orange: 0xF9_80_1D,
	magenta: 0xC7_4E_BD,
	light_blue: 0x3A_B3_DA,
	yellow: 0xFE_D8_3D,
	lime: 0x80_C7_1F,
	pink: 0xF3_8B_AA,
	gray: 0x47_4F_52,
	light_gray: 0x9D_9D_97,
	cyan: 0x16_9C_9C,
	purple: 0x89_32_B8,
	blue: 0x3C_44_AA,
	brown: 0x83_54_32,
	green: 0x5E_7C_16,
	red: 0xB0_2E_26,
	black: 0x1D_1D_21,
};


/** Skin sheet sizes the mobheads pack has base geometry for. */
export const HEAD_LAYOUTS: Record<string, string> = {
	'64x32': 'head_64_32',
	'64x64': 'head_64_64',
	'32x32': 'head_32_32',
};

/**
 * The entity sheet for a mob, preferring a file named exactly after it. Sheets
 * live at entity/<mob>.png or entity/<mob>/<mob>.png depending on the mod, and a
 * head only ever wants the base skin — never a blink or armour overlay.
 */
/**
 * Directories that hold an *overlay* rather than a mob.
 *
 * Matched as whole path segments rather than as tokens, because a token would take `chest_boat` out
 * along with `chest`. A trader llama is the case that needed it: its sheet is filed as
 * `entity/llama/decor/trader_llama`, whose leaf is exactly the mob's name — so a search by name found
 * the carpet it wears, which is a few opaque pixels on a transparent sheet, and the llama underneath
 * came out invisible on most of its faces.
 */
export const OVERLAY_DIRECTORIES = new Set([
	'decor',
	'armor',
	'markings',
	'glow',
	'eyes',
	'overlay',
	'saddle',
	'harness',
]);

/** Whether a texture is filed inside one of those, whatever the file itself is called. */
export function isOverlayPath(path: string): boolean {
	return path.split('/').slice(0, -1).some(segment => OVERLAY_DIRECTORIES.has(segment));
}

export async function findMobTexture(
	resources: ResourceManager,
	namespace: string,
	mob: string,
): Promise<ResourceLocator | null> {
	// The mod's own namespace first, then vanilla: a head for a mob the builtin
	// pack predates (bogged) has its sheet in the client jar, nested under the
	// family folder as entity/skeleton/bogged.
	for (const source of [namespace, 'minecraft']) {
		for (const candidate of [`entity/${mob}`, `entity/${mob}/${mob}`]) {
			const locator = new ResourceLocator(source, candidate);
			if (await resources.hasResource('texture', locator)) {
				return locator;
			}
		}
		let best: ResourceLocator | null = null;
		for (const locator of await resources.listResources('texture', source)) {
			const leaf = locator.path.split('/').pop();
			if (!locator.path.startsWith('entity/') || leaf !== mob || isOverlayPath(locator.path)) {
				continue;
			}
			if (best === null || locator.path.length < best.path.length) {
				best = locator;
			}
		}
		if (best) {
			return best;
		}
	}
	return null;
}


/**
 * Find the mod's own chest sheet for a chest-like item by token overlap over
 * the FULL texture path — mods keep variant sheets in per-wood directories
 * (quark's `quark_variant_chests/acacia/normal.png`), not just under entity/.
 */
export async function findChestTexture(
	resources: ResourceManager,
	namespace: string,
	itemName: string,
): Promise<ResourceLocator | null> {
	const wanted = tokens(itemName).filter(token => !FILLER_TOKENS.has(token));
	const wantTrapped = itemName.includes('trapped');
	let best: ResourceLocator | null = null;
	let bestScore = 0;
	let bestNoise = Infinity;
	for (const locator of await resources.listResources('texture', namespace)) {
		if (!locator.path.includes('chest') && !locator.path.includes('crate')) {
			continue;
		}
		const candidate = tokens(locator.path);
		if (candidate.some(token => SKIP_TOKENS.has(token))) {
			continue;
		}
		// Trapped chests must map to trapped textures and vice versa.
		const isTrapped = candidate.includes('trapped') || candidate.includes('trap');
		if (wantTrapped !== isTrapped) {
			continue;
		}
		let score = 0;
		for (const token of wanted) {
			if (candidate.includes(token)) {
				score++;
			}
		}
		if (locator.path.endsWith(`/${itemName}`) || locator.path.endsWith(`/${itemName}_0`)) {
			score++;
		}
		// A texture matching no distinguishing token is only acceptable when the
		// item name has none to offer (a mod's single plain "chest").
		if (wanted.length > 0 && score === 0) {
			continue;
		}
		// Ties go to the least-decorated path: acacia/normal beats
		// acacia/lootr_normal for plain acacia_chest.
		if (best === null || score > bestScore || (score === bestScore && candidate.length < bestNoise)) {
			best = locator;
			bestScore = score;
			bestNoise = candidate.length;
		}
	}
	return best;
}


/** Find a full modded bed entity sheet, preferring every distinguishing item-name token. */
export async function findBedTexture(
	resources: ResourceManager,
	namespace: string,
	itemName: string,
): Promise<ResourceLocator | null> {
	const wanted = tokens(itemName).filter(token => token !== 'bed');
	const hasDye = wanted.some(token => Object.hasOwn(DYE_COLORS, token));
	let best: ResourceLocator | null = null;
	let bestScore = 0;
	let bestNoise = Infinity;
	for (const locator of await resources.listResources('texture', namespace)) {
		if (!locator.path.startsWith('entity/') || !locator.path.includes('bed')) {
			continue;
		}
		const candidate = tokens(locator.path);
		let score = hasDye ? 0 : (candidate.includes('undyed') ? 1 : 0);
		for (const token of wanted) {
			if (candidate.includes(token)) {
				score++;
			}
		}
		if (score === 0) {
			continue;
		}
		if (best === null || score > bestScore || (score === bestScore && candidate.length < bestNoise)) {
			best = locator;
			bestScore = score;
			bestNoise = candidate.length;
		}
	}
	return best;
}


/**
 * Whether a sheet is a whole skin rather than an overlay. Vanilla's shulker
 * covers 44% of its sheet; a tier trim covers under 5%.
 */
export async function coversSheet(textures: TextureLoader, locator: ResourceLocator): Promise<boolean> {
	const texture = await textures.load(locator).catch(() => null);
	if (!texture) {
		return false;
	}
	let opaque = 0;
	for (let offset = 3; offset < texture.data.length; offset += 4) {
		if (texture.data[offset] > 16) {
			opaque++;
		}
	}
	return opaque / (texture.width * texture.height) > 0.2;
}

/**
 * A mod's entity sheet for a kind, preferring the one its item name points at.
 * Not restricted to `entity/`: lootr files its whole-skin sheets straight under
 * `textures/` (`lootr:shulker`), and the caller gates on coverage anyway.
 */
export async function findEntityTexture(
	resources: ResourceManager,
	namespace: string,
	itemName: string,
	kind: string,
): Promise<ResourceLocator | null> {
	const wanted = tokens(itemName).filter(token => token !== kind && token !== 'box');
	let best: ResourceLocator | null = null;
	let bestScore = -1;
	for (const locator of await resources.listResources('texture', namespace)) {
		if (!locator.path.includes(kind)) {
			continue;
		}
		const candidate = tokens(locator.path);
		// An `entity/` sheet is the conventional home, so it outranks a stray
		// match elsewhere in the tree when both name the item equally well.
		let score = locator.path.startsWith('entity/') ? 1 : 0;
		for (const token of wanted) {
			if (candidate.includes(token)) {
				score += 2;
			}
		}
		if (score > bestScore) {
			best = locator;
			bestScore = score;
		}
	}
	return best;
}

/**
 * The still sprite for a fluid block. A fluid's two frames are `<name>_still`
 * and `<name>_flow` by a convention every loader follows, but where they live
 * is up to the mod — Create puts them under `fluid/`, Immersive Engineering
 * under `block/fluid/`, Mekanism under `liquid/` — and the block is named for
 * the fluid with a suffix the mod picks.
 */
export async function findFluidStill(
	resources: ResourceManager,
	namespace: string,
	blockName: string,
): Promise<ResourceLocator | null> {
	const wanted = tokens(blockName.replace(/_?(?:fluid|liquid|block|source)$/, ''))
		.filter(token => token !== 'fluid' && token !== 'liquid' && token !== 'block');
	if (wanted.length === 0) {
		return null;
	}
	let best: ResourceLocator | null = null;
	let bestScore = 0;
	let bestNoise = Infinity;
	for (const locator of await resources.listResources('texture', namespace)) {
		if (!locator.path.endsWith('_still')) {
			continue;
		}
		const candidate = tokens(locator.path.slice(0, -'_still'.length));
		const score = wanted.filter(token => candidate.includes(token)).length;
		// Every distinguishing token has to land: `biodiesel` must not match
		// `diesel_still` when both are in the same pack.
		if (score < wanted.length) {
			continue;
		}
		if (best === null || score > bestScore || (score === bestScore && candidate.length < bestNoise)) {
			best = locator;
			bestScore = score;
			bestNoise = candidate.length;
		}
	}
	return best;
}

/**
 * A sheet filed beside a fluid's still one — its flow frames, or the overlay
 * drawn where it meets a solid face. Vanilla and most mods spell flow `_flow`;
 * some spell it `_flowing`. Only water has an overlay, and deriving it as a
 * sibling is what keeps lava from borrowing water's.
 */
export async function findFluidSibling(
	resources: ResourceManager,
	still: ResourceLocator,
	suffixes: string[],
): Promise<ResourceLocator | null> {
	const base = still.path.slice(0, -'_still'.length);
	for (const suffix of suffixes) {
		const candidate = new ResourceLocator(still.namespace, base + suffix);
		if (await resources.hasResource('texture', candidate)) {
			return candidate;
		}
	}
	return null;
}
