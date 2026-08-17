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
import {
	DYE_COLORS,
	HEAD_LAYOUTS,
	coversSheet,
	findBedTexture,
	findChestTexture,
	findEntityTexture,
	findMobTexture,
	tokens,
} from '../resources/entity-textures.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { FloatTexture } from './blend.ts';
import type { TintColor } from './face.ts';
import type { RenderOptions } from './renderer.ts';
import type { ModelLoader, ResolvedModel } from '../models/loader.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { TextureLoader } from '../textures/loader.ts';

/**
 * An item's English display name, slugified, or null. Mods do not always put the
 * kind in the id — lootr's Loot Chest is `lootr_inventory` — and the lang file is
 * a statement of what the thing is rather than a guess from its name.
 */
async function displayName(resources: ResourceManager, locator: ResourceLocator): Promise<string | null> {
	const raw = await resources.getResource('lang', new ResourceLocator(locator.namespace, 'en_us')).catch(() => null);
	if (!raw) {
		return null;
	}
	try {
		const lang = JSON.parse(raw.toString('utf8')) as Record<string, string>;
		const value = lang[`item.${locator.namespace}.${locator.path}`] ?? lang[`block.${locator.namespace}.${locator.path}`];
		return typeof value === 'string' ? value.toLowerCase().replaceAll(/[^a-z\d]+/g, '_') : null;
	} catch {
		return null;
	}
}

/** Clone a resolved model with one texture variable rebound. */
function withTexture(model: ResolvedModel, name: string, locator: ResourceLocator): ResolvedModel {
	return { ...model, textures: { ...model.textures, [name]: locator.toString() } };
}

const WHITE_BANNER: TintColor = { r: 0xF6 / 255, g: 0xFC / 255, b: 0xFB / 255 };

const DYE_PREFIX = new RegExp(`^(${Object.keys(DYE_COLORS).join('|')})_(.+)$`);

/** The dye name a `<dye>_<thing>` mod item is prefixed with, or null. */
export function dyeVariantName(id: string): string | null {
	const locator = ResourceLocator.tryParse(id);
	if (!locator || locator.namespace === 'minecraft') {
		return null;
	}
	const name = locator.path.split('/').pop() ?? locator.path;
	return DYE_PREFIX.exec(name)?.[1] ?? null;
}

/**
 * The dye color a `<dye>_<thing>` item name implies, or null. Mods that name
 * variants after dyes sometimes register the matching DyeColor as the tint in
 * client code, where no asset states it (waystones' sharestones call
 * `DyeColor.getTextColor()`), so the name is the only record of it left.
 *
 * Only ever right for variants that SHARE one uncoloured sprite. A mod that
 * draws each colour its own texture is already the right colour, and tinting it
 * again multiplies the dye in — chipped's blue_paper_lantern came out near
 * black. Callers must check the model's textures; see `dyeVariantName`.
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
	// A mod may not put the kind in the id — lootr's Loot Chest is `lootr_inventory`
	// — but its display name says so, and that name is authoritative in a way a
	// name guess is not. Appended rather than substituted so the kind guards below
	// (chestplate, shulker shell) still see the whole string.
	const searchName = `${name}_${await displayName(resources, locator) ?? ''}`;

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
	if ((searchName.includes('chest') && !searchName.includes('chestplate')) || name.endsWith('_crate')) {
		const variant = searchName.includes('ender') ? 'ender' : (searchName.includes('trapped') ? 'trapped' : 'normal');
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

	// A shulker shell is a flat sprite, never this geometry.
	if (searchName.includes('shulker') && !searchName.includes('shell')) {
		const model = await models.load('renderchest:item/shulker_box').catch(() => null);
		if (!model) {
			return null;
		}
		// The bare builtin model leaves `#texture` for a descendant to bind. A mod
		// sheet is only usable if it is a whole skin: Sophisticated Storage's tier
		// sheets are trim overlays meant to composite over the vanilla box, and
		// wearing one alone leaves nothing but floating corners.
		const candidate = await findEntityTexture(resources, locator.namespace, name, 'shulker');
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

	// Tridents — vanilla-trident-shaped, so the shared geometry covers vanilla
	// and every mod trident at once. `silentgear:trident` and friends reuse the
	// vanilla `entity/trident` sheet, so a mod's own skin is just a rebind. The
	// shaft and prongs are 1px wide in the vanilla model, so they need a
	// supersampled render — the nearest-neighbour rasterizer collapses a sub-pixel
	// face into a degenerate triangle that samples the wrong texture column.
	if (name === 'trident' || name.endsWith('_trident')) {
		const model = await models.load('renderchest:item/trident').catch(() => null);
		if (!model) {
			return null;
		}
		const sheet = await findTridentTexture(resources, locator.namespace, name)
			?? ResourceLocator.parse('minecraft:entity/trident');
		return renderModel(withTexture(model, 'texture', sheet), textures, { ...options, quality: Math.max(options.quality, 4) })
			.catch(() => null);
	}

	return null;
}

/**
 * A trident's entity sheet. Vanilla's is `entity/trident` (32×32) and mods
 * that reuse the vanilla model ship the same path under their own namespace;
 * a mod that names its sheet after the item instead (an `iron_trident` with
 * `entity/iron_trident`) is covered by the item-name fallback. Searches the
 * item's namespace first, then vanilla.
 */
async function findTridentTexture(
	resources: ResourceManager,
	namespace: string,
	itemName: string,
): Promise<ResourceLocator | null> {
	for (const source of [namespace, 'minecraft']) {
		// 1.21.8 and earlier keep the sheet at `entity/trident`; later versions
		// nest it as `entity/trident/trident` (and `entity/trident/trident_riptide`
		// for the spin state, which is never the item icon).
		for (const candidate of ['entity/trident', 'entity/trident/trident', `entity/${itemName}`]) {
			const locator = new ResourceLocator(source, candidate);
			if (await resources.hasResource('texture', locator)) {
				return locator;
			}
		}
	}
	return null;
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
