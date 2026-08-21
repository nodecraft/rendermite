/**
 * Which class holds a given entity's geometry.
 *
 * Three routes, cheapest first, because the game itself only states this in code:
 *
 * 1. `<Type>Model` — 67 of vanilla 1.21.1's types, and the reason it works is that Mojang names the
 *    class after the mob.
 * 2. `<Type>Renderer`, following its **superclass chain**. A renderer that subclasses another never
 *    mentions the model at all — `CaveSpiderRenderer` hands a layer to `SpiderRenderer`, which is
 *    where `new SpiderModel` lives — so stopping at the class itself loses every shared model in the
 *    game: cave spider, husk, stray, wither skeleton, magma cube, zoglin, all of the illagers.
 * 3. `RENDERER_ALIASES` — the mobs whose renderer is simply not named after them. A mooshroom is a
 *    `MushroomCowRenderer`, a wither is a `WitherBossRenderer`, a skeleton horse is an
 *    `UndeadHorseRenderer`. There is nothing in the assets or the class names to derive that from, so
 *    it is written down, and `NO_MODEL` below is what stops the list quietly rotting.
 *
 * The authoritative source would be `EntityRenderers.createEntityRenderers`, which registers every
 * type against its renderer — but it does so through `::new` method references, so reading it means
 * interpreting `invokedynamic` bootstrap arguments. A fifteen-line table that a test can prove
 * complete is the better trade.
 */

import { parseClassFile } from './classfile.ts';

import type { ClassFile } from './classfile.ts';
import type { Mappings } from './mappings.ts';

/**
 * Entity types whose renderer or model is not named after them. Values are class simple names to look
 * for; several may be listed because the game renamed the holder between versions — 1.21.4 folded
 * `ChestedHorseRenderer` into `DonkeyRenderer`, and a pack is exported for both eras.
 */
export const RENDERER_ALIASES: Readonly<Record<string, string | readonly string[]>> = {
	mooshroom: 'MushroomCowRenderer',
	skeleton_horse: 'UndeadHorseRenderer',
	zombie_horse: 'UndeadHorseRenderer',
	donkey: ['DonkeyRenderer', 'ChestedHorseRenderer'],
	mule: ['DonkeyRenderer', 'ChestedHorseRenderer'],
	trader_llama: 'LlamaRenderer',
	zombified_piglin: 'PiglinRenderer',
	piglin_brute: 'PiglinRenderer',
	wither: 'WitherBossRenderer',
	ender_dragon: 'EnderDragonRenderer',
	giant: 'GiantMobRenderer',
	killer_bunny: 'RabbitRenderer',
	// Neither squid renderer names a model at all, so this points straight at the model class
	glow_squid: 'SquidModel',
	// 1.14-era names, kept because a pack is exported for every version from 1.14.4 up
	magma_cube: ['LavaSlimeRenderer', 'LavaSlimeModel'],
	zombie_pigman: 'PigZombieRenderer',
	// New in the 26 line, and drawn player-shaped: there is no MannequinModel of any kind
	mannequin: 'PlayerModel',
	chest_minecart: 'MinecartRenderer',
	furnace_minecart: 'MinecartRenderer',
	hopper_minecart: 'MinecartRenderer',
	spawner_minecart: 'MinecartRenderer',
	command_block_minecart: 'MinecartRenderer',
	tnt_minecart: 'MinecartRenderer',
};

/**
 * Families whose members all draw one model, matched by suffix.
 *
 * 1.21.2 split every boat into one entity type per wood — `acacia_boat`, `birch_chest_boat`, twenty of
 * them — all still drawn by the one `BoatModel` with a different texture. A pattern is the honest way
 * to say that; twenty alias entries would say the same thing twenty times and still miss the next wood
 * Mojang adds.
 */
const FAMILY_PATTERNS: ReadonlyArray<{ suffix: string; classes: readonly string[]; }> = [
	{ suffix: '_chest_raft', classes: ['ChestRaftModel', 'RaftModel'] },
	{ suffix: '_raft', classes: ['RaftModel'] },
	{ suffix: '_chest_boat', classes: ['ChestBoatModel', 'BoatModel'] },
	{ suffix: '_boat', classes: ['BoatModel'] },
];

/**
 * Entity types the game draws without a `ModelPart` hierarchy at all, so having no geometry for them
 * is the right answer rather than a gap.
 *
 * Three kinds: things that draw a *block* or an *item* instead (a dropped stack, a falling block, a
 * thrown egg), things the renderer draws with hand-built quads (an arrow, a painting, the end
 * crystal's beam), and things that are deliberately invisible (a marker, the display entities).
 *
 * Listed rather than inferred so that a version adding a mob cannot slip through as "no model": the
 * coverage test fails on any type that is neither linked nor named here.
 */
export const NO_MODEL: ReadonlySet<string> = new Set([
	// Draws an item or a block
	'item',
	'falling_block',
	'falling_block_type',
	'tnt',
	'item_frame',
	'glow_item_frame',
	'ominous_item_spawner',
	'egg',
	'splash_potion',
	'lingering_potion',
	'wind_charge',
	'breeze_wind_charge',
	// Hand-built quads in the renderer on some versions and a real model on others: 1.21.4 gave the
	// arrows and the trident proper models. Listed anyway — an entry here only suppresses the "missing"
	// report, and a version that *does* have a model links before this list is ever consulted.
	'arrow',
	'spectral_arrow',
	'trident',
	'lightning_bolt',
	'end_crystal',
	'wither_skull',
	'shulker_bullet',
	'leash_knot',
	'llama_spit',
	'snowball',
	'potion',
	'ender_pearl',
	'experience_bottle',
	'eye_of_ender',
	'firework_rocket',
	// Hand-built geometry in the renderer, with no parts to recover
	'painting',
	'fishing_bobber',
	'experience_orb',
	'small_fireball',
	'fireball',
	'dragon_fireball',
	'area_effect_cloud',
	// Deliberately invisible
	'creaking_transient',
	'marker',
	'interaction',
	'block_display',
	'item_display',
	'text_display',
]);

/**
 * Bases that define no boxes, so landing on one from a renderer chain means finding nothing.
 *
 * Deliberately *not* `HumanoidModel` or `QuadrupedModel`, which look abstract and are anything but:
 * they are where the shared body is actually built, and every zombie, skeleton and villager in the
 * game inherits its geometry from the first. Excluding them cost six mobs.
 */
const ABSTRACT_MODELS: ReadonlySet<string> = new Set([
	'EntityModel',
	'HierarchicalModel',
	'ListModel',
	'AgeableListModel',
	'AgeableHierarchicalModel',
	'ColorableHierarchicalModel',
	'ColorableAgeableListModel',
	'ArmedModel',
	'HeadedModel',
	'SkullModelBase',
	'VillagerHeadModel',
]);

/**
 * Mapped classes called `<Name>Model`, wherever they live.
 *
 * Not a fixed package, because 1.21.11 reorganised every model into a sub-package — `CowModel` moved
 * to `client.model.animal.cow` and `TridentModel` to `client.model.object.projectile`. Matching on the
 * simple name under any `client.model` package survives that, and would have survived it in advance.
 */
function modelClassesNamed(simple: string, mappings: Mappings): string[] {
	return mappings.obfuscatedOf.keys()
		.filter(className => className.endsWith(`.${simple}Model`) && className.includes('.client.model'))
		.toArray();
}

function pascal(name: string): string {
	return name.split('_').filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1))
		.join('');
}

export interface LinkContext {
	mappings: Mappings;
	/** Reads a class by its obfuscated name, or `null` when the jar has no such class. */
	read: (obfuscated: string) => Promise<ClassFile | null>;
	/** Whether this class actually yields geometry, used to skip abstract bases. */
	hasGeometry: (obfuscated: string) => Promise<boolean>;
	/**
	 * `buildModelNameIndex` over the jar being exported, for a mod whose classes follow none of
	 * vanilla's naming. Absent for a vanilla-only link, where the named routes are exact and a fuzzy
	 * one would only ever be wrong.
	 */
	nameIndex?: Map<string, string[]>;
}

/** Every `*Model` class a class's constant pool names, deobfuscated. */
function modelsNamedBy(file: ClassFile, mappings: Mappings): string[] {
	const found = new Set<string>();
	for (const [index, constant] of file.constants.entries()) {
		if (constant?.tag !== 'class') {
			continue;
		}
		const original = mappings.originalOf.get(file.utf8(index).replaceAll('/', '.'));
		// Nested model classes exist too: the dragon's is `EnderDragonRenderer$DragonModel`
		// `TropicalFishModelA` and `…ModelB` are two real models with a variant letter appended
		if (original && /Model[A-Z]?$/.test(original) && /\.client\.(?:model|renderer)[.$]/.test(original)) {
			const simple = original.split(/[.$]/).pop() ?? '';
			if (!ABSTRACT_MODELS.has(simple)) {
				found.add(original);
			}
		}
	}
	return [...found];
}

/**
 * Walks a model class's own superclass chain for the first ancestor that defines boxes.
 *
 * `ZombieModel` extends `AbstractZombieModel` extends `HumanoidModel`, and only the last of those
 * builds anything — so a zombie's geometry is two hops above the class named after it.
 */
async function inheritedModel(
	className: string,
	context: LinkContext,
	depth = 0,
): Promise<EntityModelLink | null> {
	if (depth > 4) {
		return null;
	}
	const obfuscated = context.mappings.obfuscatedOf.get(className);
	if (!obfuscated) {
		return null;
	}
	const file = await context.read(obfuscated);
	const parent = file?.superClass?.replaceAll('/', '.');
	if (!parent || parent === 'java.lang.Object') {
		return null;
	}
	const original = context.mappings.originalOf.get(parent) ?? parent;
	const simple = original.split(/[.$]/).pop() ?? '';
	if (!ABSTRACT_MODELS.has(simple)) {
		const parentObfuscated = context.mappings.obfuscatedOf.get(original);
		if (parentObfuscated && await context.hasGeometry(parentObfuscated)) {
			return { className: original, obfuscated: parentObfuscated, route: 'model-name' };
		}
	}
	return await inheritedModel(original, context, depth + 1);
}

/** Follows a renderer's superclass chain until something names a model. */
async function modelsForRenderer(
	obfuscated: string,
	context: LinkContext,
	depth = 0,
): Promise<string[]> {
	if (depth > 4) {
		return [];
	}
	const file = await context.read(obfuscated);
	if (!file) {
		return [];
	}
	const named = modelsNamedBy(file, context.mappings);
	if (named.length > 0) {
		return named;
	}
	const parent = file.superClass?.replaceAll('/', '.');
	return parent && parent !== 'java.lang.Object'
		? await modelsForRenderer(parent, context, depth + 1)
		: [];
}

export interface EntityModelLink {
	/** Deobfuscated class name, for diagnostics and for the pack's model id. */
	className: string;
	/** The class to actually read the bytecode of. */
	obfuscated: string;
	/** How it was found, so a report can say how much rests on the curated table. */
	route: 'model-name' | 'renderer' | 'alias' | 'mod-name';
}

/**
 * A class's simple name reduced to the entity it is about.
 *
 * `Lionfish_Model`, `ModelLionfish`, `LionfishEntityModel` and `lionfish` all come out `lionfish`.
 * Mods put the marker word at either end and sometimes both — `Modelcutter` is the old MCP style,
 * `Lionfish_Model` the modern one — so the strip repeats until nothing more comes off. Separators go
 * too, because a mod's class is `Deepling_Brute_Model` where its entity is `deepling_brute`.
 */
export function normaliseModelName(name: string): string {
	let value = name.replaceAll(/[^a-z\d]/gi, '').toLowerCase();
	let previous = '';
	while (value !== previous) {
		previous = value;
		value = value
			.replace(/^(?:model|entity|render(?:er)?)/, '')
			.replace(/(?:model|entity|render(?:er)?)$/, '');
	}
	return value;
}

/**
 * Normalised name → the classes that could be it, for a jar whose classes are not named the way
 * vanilla's are.
 *
 * Built once per jar because the alternative is scanning three thousand classes per entity. Nested
 * classes are indexed under the part after the `$` as well: occultism files a familiar's head as
 * `HeadlessFamiliarRenderer$CthulhuHeadModel`, and only the tail of that names the mob.
 */
export function buildModelNameIndex(internalNames: Iterable<string>): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const internal of internalNames) {
		const simple = internal.split('/').pop() ?? '';
		// Only classes that look like a model at all; a mod jar is mostly not models
		if (!/model/i.test(simple)) {
			continue;
		}
		for (const candidate of [simple, ...simple.split('$').slice(1)]) {
			const key = normaliseModelName(candidate);
			if (key.length < 3) {
				continue;
			}
			const held = index.get(key);
			if (held) {
				held.push(internal);
			} else {
				index.set(key, [internal]);
			}
		}
	}
	return index;
}

/**
 * The class holding one entity's geometry, or `null` when nothing links.
 *
 * A candidate is only accepted if it *yields geometry*: a renderer chain can land on an abstract base
 * that names no boxes, and returning that would report coverage the pack does not have.
 */
export async function linkEntityModel(
	entityId: string,
	context: LinkContext,
): Promise<EntityModelLink | null> {
	const name = entityId.includes(':') ? entityId.slice(entityId.indexOf(':') + 1) : entityId;
	const { mappings } = context;

	const accept = async (className: string, route: EntityModelLink['route']): Promise<EntityModelLink | null> => {
		const obfuscated = mappings.obfuscatedOf.get(className);
		if (!obfuscated || !await context.hasGeometry(obfuscated)) {
			return null;
		}
		return { className, obfuscated, route };
	};

	for (const className of modelClassesNamed(pascal(name), mappings)) {
		const direct = await accept(className, 'model-name');
		if (direct) {
			return direct;
		}
		/*
		 * The named model exists but builds nothing of its own: `ZombieModel` and `CatModel` are both
		 * empty shells over a parent that holds the boxes. Walking up finds them, and it is the same walk
		 * the renderer route does one level out.
		 */
		const inherited = await inheritedModel(className, context);
		if (inherited) {
			return inherited;
		}
	}

	const family = FAMILY_PATTERNS.find(candidate => name.endsWith(candidate.suffix))?.classes ?? [];
	const aliased = RENDERER_ALIASES[name];
	const attempts: Array<[string, EntityModelLink['route']]> = [
		...(typeof aliased === 'string' ? [aliased] : aliased ?? []).map(simple => [simple, 'alias'] as [string, EntityModelLink['route']]),
		...family.map(simple => [simple, 'alias'] as [string, EntityModelLink['route']]),
		[`${pascal(name)}Renderer`, 'renderer'],
	];
	for (const [simple, route] of attempts) {
		if (!simple) {
			continue;
		}
		/*
		 * An alias may name a *model* as readily as a renderer — the squid family's renderers name no
		 * model anywhere, so the only way to say where a glow squid's boxes are is to point at
		 * `SquidModel` directly.
		 */
		const candidates = mappings.obfuscatedOf.keys()
			.filter(className => className.endsWith(`.${simple}`) && /\.client\.(?:model|renderer)[.$]/.test(className))
			.toArray();
		// Longest package first, so a reorganised jar's concrete class beats a same-named shim
		candidates.sort((left, right) => right.length - left.length);
		for (const className of candidates) {
			const direct = await accept(className, route) ?? await inheritedModel(className, context);
			if (direct) {
				return { ...direct, route };
			}
			const obfuscated = mappings.obfuscatedOf.get(className);
			if (!obfuscated) {
				continue;
			}
			for (const model of await modelsForRenderer(obfuscated, context)) {
				const accepted = await accept(model, route) ?? await inheritedModel(model, context);
				if (accepted) {
					return { ...accepted, route };
				}
			}
		}
	}

	/*
	 * Last: the mod route. A mod names its classes however it likes, so the only thing left is the name
	 * itself, reduced to the entity it is about. Deliberately after every exact route — a fuzzy match is
	 * a guess, and it must never beat a class the game actually points at.
	 */
	for (const internal of context.nameIndex?.get(normaliseModelName(name)) ?? []) {
		const dotted = internal.replaceAll('/', '.');
		if (await context.hasGeometry(dotted)) {
			return { className: dotted, obfuscated: dotted, route: 'mod-name' };
		}
	}
	return null;
}

/** Reads and caches classes out of an extracted jar directory or a jar reader. */
export function classReader(load: (obfuscated: string) => Promise<Uint8Array | null>): LinkContext['read'] {
	const cache = new Map<string, ClassFile | null>();
	return async (obfuscated) => {
		if (cache.has(obfuscated)) {
			return cache.get(obfuscated) ?? null;
		}
		let parsed: ClassFile | null = null;
		const bytes = await load(obfuscated);
		if (bytes) {
			try {
				parsed = parseClassFile(bytes);
			} catch {
				parsed = null;
			}
		}
		cache.set(obfuscated, parsed);
		return parsed;
	};
}
