/**
 * The entity registry, and one colour per entity.
 *
 * A world viewer has no geometry for a mob — nothing in any jar does, at any version, because entity
 * models are Java code — so what it draws is a box the size of the hitbox. Two things make that box
 * worth looking at rather than merely present: the entity's *name*, so a reader knows what it is, and
 * the entity's *colour*, so a pen of cows does not read as the same grey mass as the shoal beside it.
 *
 * Both come out of the assets today, with no geometry decision made:
 *
 * - The registry is the lang file. `entity.<ns>.<name>` is written per registered entity type by
 *   datagen, so it is the closest thing a jar carries to the entity registry — the same trick the item
 *   sheet uses to tell a real item from a template model.
 * - The colour is the mean of the opaque pixels of the entity's own texture sheet. Crude on purpose:
 *   it is a marker's tint, not a render, and a mean is the one summary that cannot be wrong about
 *   which mob it came from.
 *
 * `texture` is carried alongside so that whatever eventually draws real entity geometry has the
 * id → sheet mapping already resolved, which is the fiddly half of the problem.
 */

import { findMobTexture, isOverlayPath, tokens } from '../resources/entity-textures.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { EntityPackEntry } from './pack-format.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { Texture, TextureLoader } from '../textures/loader.ts';

/** `entity.<ns>.<name>`, and only the plain ones: a deeper key is a subtitle or a variant label. */
const ENTITY_KEY_SEGMENTS = 3;

/**
 * Texture names filed under a mob's own directory that are not the mob.
 *
 * A llama's directory holds `spit`, which is the projectile it throws; a horse's holds its armour, a
 * cat's its collar, a happy ghast's its harness. Those score exactly as well on name overlap as the
 * body sheet does — `entity/llama/spit` and `entity/llama/creamy` both name the llama and sit at the
 * same depth — so without this the tie breaks arbitrarily and a llama comes out the colour of spit.
 *
 * Overlays are here for the same reason: a blink or an eye layer is a few opaque pixels whose mean
 * says nothing about the animal.
 */
const NOT_THE_MOB = new Set([
	'spit',
	'armor',
	'saddle',
	'collar',
	'harness',
	'chest',
	'overlay',
	'blink',
	'eyes',
	'markings',
	'glow',
]);

/**
 * Alpha at or below which a pixel does not count toward the mean.
 *
 * Not zero: mob sheets are full of near-transparent antialiasing at the edges of a part, and letting
 * those in drags every colour toward whatever the sheet's background happens to be.
 */
const OPAQUE_ALPHA = 128;

export interface EntityPackResult {
	entities: Record<string, EntityPackEntry>;
	failures: Array<{ id: string; reason: string; }>;
}

/** The mean of a texture's opaque pixels as `#rrggbb`, or `null` when it has none. */
function meanColor(texture: Texture): string | null {
	let red = 0;
	let green = 0;
	let blue = 0;
	let counted = 0;
	for (let offset = 0; offset < texture.data.length; offset += 4) {
		if (texture.data[offset + 3] <= OPAQUE_ALPHA) {
			continue;
		}
		red += texture.data[offset];
		green += texture.data[offset + 1];
		blue += texture.data[offset + 2];
		counted++;
	}
	if (counted === 0) {
		return null;
	}
	return `#${[red, green, blue]
		.map(channel => Math.round(channel / counted).toString(16).padStart(2, '0'))
		.join('')}`;
}

/**
 * Every entity type a namespace registers, by its lang keys.
 *
 * Keys with more segments than `<prefix>.<ns>.<name>` are dropped: those are a variant's own label
 * (`entity.minecraft.villager.farmer`) or a death message, never a type.
 */
export async function entityTypesOf(resources: ResourceManager, namespace: string): Promise<Array<{ id: string; name: string; }>> {
	const raw = await resources.getResource('lang', new ResourceLocator(namespace, 'en_us'));
	if (!raw) {
		return [];
	}
	let lang: Record<string, unknown>;
	try {
		lang = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
	} catch {
		return [];
	}
	const prefix = `entity.${namespace}.`;
	const types: Array<{ id: string; name: string; }> = [];
	for (const [key, value] of Object.entries(lang)) {
		if (!key.startsWith(prefix) || key.split('.').length !== ENTITY_KEY_SEGMENTS || typeof value !== 'string') {
			continue;
		}
		types.push({ id: `${namespace}:${key.slice(prefix.length)}`, name: value });
	}
	return types;
}

/**
 * A mob's sheet where the conventional paths do not have it.
 *
 * `findMobTexture` wants a file named exactly after the entity, which is how most of them are filed.
 * The rest are named after a *variant* — a rabbit is `entity/rabbit/brown`, a horse is
 * `entity/horse/horse_white`, an elder guardian is `entity/guardian/guardian_elder` — so this falls
 * back to the best token overlap under `entity/`, preferring a shallower path so a family's plain
 * sheet beats its armour or blink overlay.
 *
 * Restricted to `entity/` deliberately. Widening it finds a *block* texture with a matching word for
 * anything that has no sheet at all, and a lectern-coloured marker is worse than no colour.
 *
 * The name is also matched with its underscores squashed out, which is a real vanilla convention and
 * not a guess: an armour stand is filed under `entity/armorstand/` and a magma cube is
 * `entity/slime/magmacube`, and neither shares a single token with its own id.
 */
async function findVariantTexture(
	resources: ResourceManager,
	namespace: string,
	name: string,
): Promise<ResourceLocator | null> {
	const wanted = tokens(name);
	const squashed = name.replaceAll('_', '');
	let best: ResourceLocator | null = null;
	let bestScore = 0;
	for (const locator of await resources.listResources('texture', namespace)) {
		if (!locator.path.startsWith('entity/')) {
			continue;
		}
		const leaf = locator.path.split('/').at(-1) ?? '';
		if (tokens(leaf).some(token => NOT_THE_MOB.has(token))) {
			continue;
		}
		// An overlay's own directory says what it is, whatever the file inside it is called
		if (isOverlayPath(locator.path)) {
			continue;
		}
		const candidate = tokens(locator.path);
		let score = 0;
		for (const token of wanted) {
			if (candidate.includes(token)) {
				score += 2;
			}
		}
		// Worth as much as naming every token, since it is the whole name in one piece
		if (squashed !== name && candidate.includes(squashed)) {
			score += wanted.length * 2;
		}
		if (score === 0) {
			continue;
		}
		/*
		 * Ranked in three tiers, because token overlap alone ties far too often and the tie-break was
		 * length — which picked whichever file happened to have the shortest name.
		 *
		 * **The family's own folder wins outright.** A sheet under a directory named after part of the
		 * entity is a member of that family: a trader llama's body is `entity/llama/gray`, which tied with
		 * `entity/wandering_trader` — the *human* trader's skin — and lost for being one character longer.
		 * The folder's own tokens all have to appear in the name, so `entity/chest_boat/` qualifies for a
		 * chest boat and `entity/chest/` still qualifies but then loses on overlap.
		 *
		 * **Then the file naming the mob.** Every sheet in `entity/horse/` is in the family, so without
		 * this a horse took `mule` over `horse_white` on the same length tie-break.
		 */
		const folder = locator.path.split('/').slice(1, -1);
		const inFamily = folder.length > 0
			&& folder.flatMap(segment => tokens(segment)).every(token => wanted.includes(token));
		const named = tokens(leaf).some(token => wanted.includes(token));
		const depth = locator.path.split('/').length;
		score = (inFamily ? 1000 : 0) + score * 10 + (named ? 5 : 0) - depth - candidate.length;
		if (score > bestScore) {
			best = locator;
			bestScore = score;
		}
	}
	return best;
}

export interface CollectEntitiesOptions {
	resources: ResourceManager;
	textures: TextureLoader;
	namespaces: readonly string[];
	onProgress?: (done: number, total: number) => void;
}

export async function collectEntities(options: CollectEntitiesOptions): Promise<EntityPackResult> {
	const { resources, textures } = options;
	const entities: Record<string, EntityPackEntry> = {};
	const failures: Array<{ id: string; reason: string; }> = [];

	const types: Array<{ id: string; name: string; }> = [];
	for (const namespace of options.namespaces) {
		types.push(...await entityTypesOf(resources, namespace));
	}
	let done = 0;
	for (const type of types.toSorted((left, right) => left.id.localeCompare(right.id))) {
		options.onProgress?.(++done, types.length);
		const [namespace, name] = [type.id.slice(0, type.id.indexOf(':')), type.id.slice(type.id.indexOf(':') + 1)];
		const entry: EntityPackEntry = { name: type.name };
		const locator = await findMobTexture(resources, namespace, name)
			?? await findVariantTexture(resources, namespace, name);
		if (locator) {
			const texture = await textures.load(locator).catch(() => null);
			const colour = texture ? meanColor(texture) : null;
			entry.texture = locator.toString();
			if (colour) {
				entry.color = colour;
			} else {
				failures.push({ id: type.id, reason: `texture ${locator} has no opaque pixels; exported without a colour` });
			}
		} else {
			/*
			 * Expected for everything that is not a mob: an item entity, a falling block, a marker, a
			 * display, a thrown projectile. Those draw from an item or a block rather than an entity
			 * sheet, so they have no colour of their own and none is invented for them.
			 */
			failures.push({ id: type.id, reason: 'no entity texture found; exported without a colour' });
		}
		entities[type.id] = entry;
	}

	return { entities, failures };
}
