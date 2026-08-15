/**
 * Heuristic rendering for mod items that parent `builtin/entity` — chests,
 * mob heads, banners, shulker boxes drawn by Java code in-game. The sweep
 * found 351 of these across the top mods (quark's lootr chests, spectrum's
 * mob heads, deeperdarker's chests). We map them onto the builtin geometry by
 * name, preferring the mod's own entity texture when one matches; a generic
 * chest icon for a chest item beats no icon, but nothing here ever guesses
 * across item kinds.
 */

import { renderModel } from './renderer.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { FloatTexture } from './blend.ts';
import type { TintColor } from './face.ts';
import type { RenderOptions } from './renderer.ts';
import type { ModelLoader, ResolvedModel } from '../models/loader.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { TextureLoader } from '../textures/loader.ts';

/** Tokens too generic to identify a texture on their own. */
const FILLER_TOKENS = new Set(['chest', 'chests', 'crate', 'crates', 'trapped', 'big', 'small', 'the', 'of']);

/** Double-chest halves, lid states, boat sheets, seasonal skins — never icon textures. */
const SKIP_TOKENS = new Set(['left', 'right', 'open', 'opened', 'christmas', 'boat', 'raft', 'minecart']);

function tokens(name: string): string[] {
	return name.split(/[./_]/).filter(token => token.length > 1);
}

/**
 * Find the mod's own chest sheet for a chest-like item by token overlap over
 * the FULL texture path — mods keep variant sheets in per-wood directories
 * (quark's `quark_variant_chests/acacia/normal.png`), not just under entity/.
 */
async function findChestTexture(
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

/** Clone a resolved model with one texture variable rebound. */
function withTexture(model: ResolvedModel, name: string, locator: ResourceLocator): ResolvedModel {
	return { ...model, textures: { ...model.textures, [name]: locator.toString() } };
}

const WHITE_BANNER: TintColor = { r: 0xF6 / 255, g: 0xFC / 255, b: 0xFB / 255 };

/** Vanilla DyeColor diffuse colors, keyed by the dye name mods prefix with. */
const DYE_COLORS: Record<string, number> = {
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

const DYE_PREFIX = new RegExp(`^(${Object.keys(DYE_COLORS).join('|')})_(.+)$`);

/** Skin sheet sizes the mobheads pack has base geometry for. */
const HEAD_LAYOUTS: Record<string, string> = {
	'64x32': 'head_64_32',
	'64x64': 'head_64_64',
	'32x32': 'head_32_32',
};

/**
 * The entity sheet for a mob, preferring a file named exactly after it. Sheets
 * live at entity/<mob>.png or entity/<mob>/<mob>.png depending on the mod, and a
 * head only ever wants the base skin — never a blink or armour overlay.
 */
async function findMobTexture(
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
			if (!locator.path.startsWith('entity/') || leaf !== mob) {
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

/** Find a full modded bed entity sheet, preferring every distinguishing item-name token. */
async function findBedTexture(
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
 * The dye color a `<dye>_<thing>` item name implies, or null. Mods that name
 * variants after dyes usually register the matching DyeColor as the tint in
 * client code, where no asset states it (waystones' sharestones call
 * `DyeColor.getTextColor()`), so the name is the only record of it left.
 */
export function dyedVariantTint(id: string): TintColor | null {
	const locator = ResourceLocator.tryParse(id);
	if (!locator || locator.namespace === 'minecraft') {
		return null;
	}
	const name = locator.path.split('/').pop() ?? locator.path;
	const match = DYE_PREFIX.exec(name);
	if (!match) {
		return null;
	}
	const color = DYE_COLORS[match[1]];
	return {
		r: ((color >>> 16) & 0xFF) / 255,
		g: ((color >>> 8) & 0xFF) / 255,
		b: (color & 0xFF) / 255,
	};
}

/**
 * Dyed variants of vanilla items whose models mods generate at runtime (quark's
 * `black_frame_empty` parents a block model that exists nowhere on disk): render
 * the vanilla base item tinted with the dye color. Suffixes like `_empty`/`_map`
 * are state variants of the same icon.
 */
export async function renderDyedVariantFallback(
	id: string,
	models: ModelLoader,
	textures: TextureLoader,
	options: RenderOptions,
): Promise<FloatTexture | null> {
	const locator = ResourceLocator.parse(id);
	if (locator.namespace === 'minecraft') {
		return null;
	}
	const name = locator.path.split('/').pop() ?? locator.path;
	const match = DYE_PREFIX.exec(name);
	if (!match) {
		return null;
	}
	const base = match[2].replace(/_(?:empty|map)$/, '');
	const color = DYE_COLORS[match[1]];
	const tint: TintColor = {
		r: ((color >>> 16) & 0xFF) / 255,
		g: ((color >>> 8) & 0xFF) / 255,
		b: (color & 0xFF) / 255,
	};
	// `frame` → vanilla `item_frame`; the bare name is tried first.
	for (const candidate of [`minecraft:item/${base}`, `minecraft:item/item_${base}`]) {
		try {
			const model = await models.load(candidate);
			return await renderModel(model, textures, { ...options, tints: [tint] });
		} catch {
			continue;
		}
	}
	return null;
}

/** Non-body entity sheets that would skew a mob's dominant colors. */
const EGG_SKIP_TOKENS = new Set(['eyes', 'glow', 'emissive', 'overlay', 'saddle', 'armor', 'markings']);

/**
 * Derive spawn-egg tints from the mob's entity texture. Mod egg colors live
 * in item-registration code, so the two dominant colors of the entity skin
 * stand in: primary = biggest color cluster, secondary = biggest cluster
 * visually distinct from it. Returns null when no entity texture matches —
 * the egg then renders untinted, as before.
 */
export async function spawnEggTints(
	id: string,
	resources: ResourceManager,
	textures: TextureLoader,
): Promise<TintColor[] | null> {
	const locator = ResourceLocator.parse(id);
	if (locator.namespace === 'minecraft') {
		return null;
	}
	const name = locator.path.split('/').pop() ?? locator.path;
	const mob = /^spawn_egg_(.+)$/.exec(name)?.[1] ?? /^(.+)_spawn_egg$/.exec(name)?.[1];
	if (!mob) {
		return null;
	}
	const wanted = mob.split('_').filter(token => token.length > 1);
	let best: ResourceLocator | null = null;
	let bestScore = 0;
	let bestNoise = Infinity;
	for (const candidate of await resources.listResources('texture', locator.namespace)) {
		if (!candidate.path.startsWith('entity/')) {
			continue;
		}
		const parts = candidate.path.split(/[./_]/).filter(token => token.length > 1);
		if (parts.some(token => EGG_SKIP_TOKENS.has(token))) {
			continue;
		}
		let score = 0;
		for (const token of wanted) {
			if (parts.includes(token)) {
				score++;
			}
		}
		if (score === 0) {
			continue;
		}
		if (score > bestScore || (score === bestScore && parts.length < bestNoise)) {
			best = candidate;
			bestScore = score;
			bestNoise = parts.length;
		}
	}
	const skin = best ? await textures.load(best) : null;
	if (!skin) {
		return null;
	}

	// Quantize to 32-level buckets and average within each; the two biggest
	// well-separated clusters make convincing base + spots colors.
	const buckets = new Map<number, [r: number, g: number, b: number, count: number]>();
	for (let offset = 0; offset < skin.data.length; offset += 4) {
		if (skin.data[offset + 3] <= 128) {
			continue;
		}
		const key = ((skin.data[offset] >> 5) << 6) | ((skin.data[offset + 1] >> 5) << 3) | (skin.data[offset + 2] >> 5);
		const bucket = buckets.get(key) ?? [0, 0, 0, 0];
		bucket[0] += skin.data[offset];
		bucket[1] += skin.data[offset + 1];
		bucket[2] += skin.data[offset + 2];
		bucket[3]++;
		buckets.set(key, bucket);
	}
	const clusters = buckets.values().toArray()
		.toSorted((a, b) => b[3] - a[3])
		.map(([r, g, b, count]) => {
			return { r: r / count / 255, g: g / count / 255, b: b / count / 255, count };
		});
	if (clusters.length === 0) {
		return null;
	}
	const primary = clusters[0];
	const distance = (a: TintColor, b: TintColor) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
	const secondary = clusters.find(cluster => distance(cluster, primary) > 0.25)
		?? { r: primary.r * 0.6, g: primary.g * 0.6, b: primary.b * 0.6 };
	return [
		{ r: primary.r, g: primary.g, b: primary.b },
		{ r: secondary.r, g: secondary.g, b: secondary.b },
	];
}

/**
 * Render a code-rendered (builtin/entity) item through builtin geometry when
 * its name identifies the kind. Returns null when no heuristic applies —
 * this must never guess across kinds.
 */
export async function renderEntityFallback(
	id: string,
	models: ModelLoader,
	textures: TextureLoader,
	resources: ResourceManager,
	options: RenderOptions,
): Promise<FloatTexture | null> {
	const locator = ResourceLocator.parse(id);
	const name = locator.path.split('/').pop() ?? locator.path;

	// Mob heads/skulls: map onto the builtin mobheads namespace when the mob
	// name matches one of its 90+ models (spectrum ships vanilla-mob heads).
	const headMatch = /^(.+?)_(?:head|skull)$/.exec(name);
	if (headMatch) {
		const mob = headMatch[1].replace(/^(?:carved|wall|floor)_/, '');
		// Variant suffixes (axolotl_blue, parrot_red, fox_arctic) shed trailing
		// tokens until a builtin mob matches — at most two, so a custom mob's
		// long name can't collapse onto an unrelated vanilla head.
		const parts = mob.split('_');
		for (let keep = parts.length; keep >= 1 && keep >= parts.length - 2; keep--) {
			try {
				const model = await models.load(`mobheads:item/${parts.slice(0, keep).join('_')}`);
				return await renderModel(model, textures, options);
			} catch {
				continue;
			}
		}
		// A mob the builtin pack has never heard of — a mod's own creature, or one
		// vanilla added after the pack was vendored. The head is the same eight
		// pixels either way, so bind the mod's own entity sheet to the base
		// geometry rather than giving up.
		const sheet = await findMobTexture(resources, locator.namespace, mob);
		const skin = sheet ? await textures.load(sheet).catch(() => null) : null;
		// Only a real skin layout can be worn as a head. A creature sheet of some
		// other size unwraps into confetti, which is worse than no icon, so the
		// size has to match one of the pack's own base models exactly.
		const base = skin ? HEAD_LAYOUTS[`${skin.width}x${skin.height}`] : undefined;
		if (sheet && base) {
			const geometry = await models.load(`mobheads:item/base/${base}`).catch(() => null);
			if (geometry) {
				return renderModel(withTexture(geometry, 'texture', sheet), textures, options);
			}
		}
		return null;
	}

	// Chests — but never chestplates.
	if ((name.includes('chest') && !name.includes('chestplate')) || name.endsWith('_crate')) {
		const variant = name.includes('ender') ? 'ender' : (name.includes('trapped') ? 'trapped' : 'normal');
		// The modern builtin nests per-variant wrappers; the legacy one has a
		// single geometry expecting a #texture binding.
		const candidates: Array<[model: string, defaultTexture: string | null]> = [
			[`renderchest:item/chest/${variant === 'normal' ? 'chest' : `${variant}_chest`}`, null],
			['renderchest:item/chest', `minecraft:entity/chest/${variant}`],
		];
		const modTexture = await findChestTexture(resources, locator.namespace, name);
		for (const [modelPath, defaultTexture] of candidates) {
			try {
				const model = await models.load(modelPath);
				let rebound = model;
				if (modTexture && await textures.load(modTexture)) {
					rebound = withTexture(model, 'texture', modTexture);
				} else if (defaultTexture) {
					rebound = withTexture(model, 'texture', ResourceLocator.parse(defaultTexture));
				}
				return await renderModel(rebound, textures, options);
			} catch {
				continue;
			}
		}
		return null;
	}

	if (name === 'bed' || name.endsWith('_bed')) {
		const modTexture = await findBedTexture(resources, locator.namespace, name);
		if (modTexture) {
			try {
				const model = await models.load('renderchest:item/bed');
				return await renderModel(withTexture(model, 'texture', modTexture), textures, options);
			} catch {
				return null;
			}
		}
	}

	if (name.includes('shulker_box')) {
		const model = await models.load('renderchest:item/shulker_box').catch(() => null);
		if (!model) {
			return null;
		}
		// The bare builtin model leaves `#texture` for a descendant to bind. A mod
		// sheet is only usable if it is a whole skin: Sophisticated Storage's tier
		// sheets are trim overlays meant to composite over the vanilla box, and
		// wearing one alone leaves nothing but floating corners.
		const candidate = await findShulkerTexture(resources, locator.namespace, name);
		const sheet = candidate && await coversSheet(textures, candidate)
			? candidate
			: ResourceLocator.parse('minecraft:entity/shulker/shulker');
		return renderModel(withTexture(model, 'texture', sheet), textures, options).catch(() => null);
	}

	if (name.endsWith('banner')) {
		try {
			const model = await models.load('renderchest:item/banner');
			return await renderModel(model, textures, { ...options, tints: [WHITE_BANNER] });
		} catch {
			return null;
		}
	}

	// Shields — the geometry is one board either way, so the only question is
	// whose face to put on it. A mod's own shields keep their sheet beside
	// vanilla's under entity/, named after the material.
	if (name.includes('shield')) {
		const model = await models.load('renderchest:item/shield').catch(() => null);
		if (!model) {
			return null;
		}
		const sheet = await findShieldTexture(resources, locator.namespace, name);
		return renderModel(sheet ? withTexture(model, 'texture', sheet) : model, textures, options);
	}

	return null;
}

/**
 * Whether a sheet is a whole skin rather than an overlay. Vanilla's shulker
 * covers 44% of its sheet; a tier trim covers under 5%.
 */
async function coversSheet(textures: TextureLoader, locator: ResourceLocator): Promise<boolean> {
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

/** A mod's shulker box sheet, preferring the one its name points at. */
async function findShulkerTexture(
	resources: ResourceManager,
	namespace: string,
	itemName: string,
): Promise<ResourceLocator | null> {
	const wanted = tokens(itemName).filter(token => token !== 'shulker' && token !== 'box');
	let best: ResourceLocator | null = null;
	let bestScore = -1;
	for (const locator of await resources.listResources('texture', namespace)) {
		if (!locator.path.startsWith('entity/') || !locator.path.includes('shulker')) {
			continue;
		}
		const candidate = tokens(locator.path);
		let score = 0;
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
 * A mod's shield face, scored by how much of the item name it accounts for.
 * `_blocking` is the raised pose rather than a different shield, and a
 * `_nopattern` sheet is the plain one a banner would otherwise decorate.
 */
async function findShieldTexture(
	resources: ResourceManager,
	namespace: string,
	itemName: string,
): Promise<ResourceLocator | null> {
	const wanted = tokens(itemName).filter(token => token !== 'shield' && token !== 'blocking');
	let best: ResourceLocator | null = null;
	let bestScore = 0;
	for (const locator of await resources.listResources('texture', namespace)) {
		if (!locator.path.startsWith('entity/') || !locator.path.includes('shield')) {
			continue;
		}
		const candidate = tokens(locator.path);
		let score = candidate.includes('nopattern') ? 1 : 0;
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
