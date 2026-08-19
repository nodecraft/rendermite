/**
 * Real blockstate evaluation: given a block's actual property map, the models
 * the game would draw for it.
 *
 * `src/items/blockstate.ts` reads the same files but answers a different
 * question — "which variant looks most like a fresh block", so an item icon has
 * something to draw. A chunk renderer knows `facing=north,half=bottom` and needs
 * the model that key names, every model when several apply, and the whole
 * weighted list when the game would pick one at random.
 *
 * Everything here is parse-once: the string keys, the `a|b` alternates and the
 * `OR`/`AND` nesting are all resolved into structures, because the exported pack
 * is meant to leave the consumer nothing to resolve at runtime.
 */

import { ResourceLocator } from '../resources/locator.ts';

/** A placed block's properties, stringified the way blockstate keys write them. */
export type BlockProperties = Readonly<Record<string, string>>;

export interface BlockModelVariant {
	/** Fully-qualified model locator (`minecraft:block/oak_stairs`). */
	model: string;
	/** Blockstate rotation in degrees about X, applied to the baked model. */
	x: number;
	/** Blockstate rotation in degrees about Y. */
	y: number;
	/**
	 * Rotation about Z, applied after X and Y. Vanilla has no third axis; AE2
	 * adds one as `ae2:z` so a drive or charger can spin on the wall it faces.
	 */
	z: number;
	/** Hold UVs still while the model rotates. */
	uvlock: boolean;
	/** Relative weight within its list; the game picks one per block position. */
	weight: number;
}

/**
 * One entry of a `variants` map, with its `a=b,c=d` key already parsed.
 *
 * Generic over the variant because the evaluation reads only `model`: a pack
 * consumer holds variants whose rotations are optional (the emit omits them at
 * their defaults) and can evaluate those directly, getting its own shape back.
 */
export interface BlockStateVariantCase<Variant extends { model: string; } = BlockModelVariant> {
	/** Properties this case constrains; unstated ones are wildcards. */
	when: Record<string, string>;
	apply: Variant[];
}

/**
 * A `multipart` predicate. `match` holds one or more accepted values per
 * property (the `a|b|c` form), and every property in it must match.
 */
export type MultipartCondition =
	| { op: 'match'; properties: Record<string, string[]>; }
	| { op: 'and'; terms: MultipartCondition[]; }
	| { op: 'or'; terms: MultipartCondition[]; };

export interface BlockStateMultipartCase<Variant extends { model: string; } = BlockModelVariant> {
	/** null for an unconditional part, which always applies. */
	when: MultipartCondition | null;
	apply: Variant[];
}

export type BlockStateDefinition<Variant extends { model: string; } = BlockModelVariant> =
	| { kind: 'variants'; cases: Array<BlockStateVariantCase<Variant>>; }
	| { kind: 'multipart'; cases: Array<BlockStateMultipartCase<Variant>>; };

export class BlockStateError extends Error {}

/** JSON writes booleans and numbers unquoted; blockstate keys write them as text. */
function propertyValue(value: unknown): string {
	return typeof value === 'string' ? value : String(value);
}

/**
 * The third rotation axis, which vanilla does not have. AE2 writes it as
 * `ae2:z`; the namespace is left open because a loader extension is a loader
 * extension whoever ships it, and only a numeric `z` key can match.
 */
function zRotation(entry: Record<string, unknown>): number {
	for (const [name, value] of Object.entries(entry)) {
		if ((name === 'z' || name.endsWith(':z')) && typeof value === 'number') {
			return value;
		}
	}
	return 0;
}

/** Null for an explicit `weight: 0`, which the game can never pick. */
function parseVariant(namespace: string, raw: unknown, context: string): BlockModelVariant | null {
	if (typeof raw !== 'object' || raw === null) {
		throw new BlockStateError(`${context}: variant is not an object`);
	}
	const entry = raw as { model?: unknown; x?: unknown; y?: unknown; uvlock?: unknown; weight?: unknown; };
	if (typeof entry.model !== 'string' || entry.model.length === 0) {
		throw new BlockStateError(`${context}: variant states no model`);
	}
	const model = ResourceLocator.tryParse(entry.model, namespace);
	if (model === null) {
		throw new BlockStateError(`${context}: unparseable model ${entry.model}`);
	}
	const weight = typeof entry.weight === 'number' ? entry.weight : 1;
	if (!Number.isFinite(weight) || weight <= 0) {
		return null;
	}
	return {
		model: model.toString(),
		x: typeof entry.x === 'number' ? entry.x : 0,
		y: typeof entry.y === 'number' ? entry.y : 0,
		z: zRotation(raw as Record<string, unknown>),
		uvlock: entry.uvlock === true,
		weight,
	};
}

function parseApply(namespace: string, raw: unknown, context: string): BlockModelVariant[] {
	const entries = Array.isArray(raw) ? raw : [raw];
	if (entries.length === 0) {
		throw new BlockStateError(`${context}: empty variant list`);
	}
	// Dropping the unpickable ones rather than emitting a weight total the
	// consumer has to guard against; nothing left to draw is a broken state.
	const variants = entries.map(entry => parseVariant(namespace, entry, context)).filter(variant => variant !== null);
	if (variants.length === 0) {
		throw new BlockStateError(`${context}: every variant has weight 0`);
	}
	return variants;
}

/** `facing=north,half=bottom` → `{ facing: 'north', half: 'bottom' }`; `''` → `{}`. */
function parseVariantKey(key: string, context: string): Record<string, string> {
	const when: Record<string, string> = {};
	if (key.length === 0) {
		return when;
	}
	for (const pair of key.split(',')) {
		const separator = pair.indexOf('=');
		if (separator <= 0) {
			// A bare key rather than `property=value` is the pre-1.13 Forge shape
			// (`"normal"`, `"inventory"`), which needs the numeric-id table the
			// 1.13 floor exists to avoid. Say which it is.
			throw new BlockStateError(`${context}: variant key segment "${pair}" states no property; a bare key is the pre-1.13 format, below this exporter's floor`);
		}
		when[pair.slice(0, separator)] = pair.slice(separator + 1);
	}
	return when;
}

function parseCondition(raw: unknown, context: string): MultipartCondition {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new BlockStateError(`${context}: "when" is not an object`);
	}
	const terms: MultipartCondition[] = [];
	const properties: Record<string, string[]> = {};
	for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
		// OR/AND alongside plain properties is not something vanilla writes, but
		// ANDing whatever is present degrades to the right answer either way.
		if (name === 'OR' || name === 'AND') {
			if (!Array.isArray(value)) {
				throw new BlockStateError(`${context}: "${name}" is not an array`);
			}
			terms.push({
				op: name === 'OR' ? 'or' : 'and',
				terms: value.map(entry => parseCondition(entry, context)),
			});
			continue;
		}
		properties[name] = propertyValue(value).split('|');
	}
	if (Object.keys(properties).length > 0) {
		terms.push({ op: 'match', properties });
	}
	if (terms.length === 0) {
		throw new BlockStateError(`${context}: empty "when"`);
	}
	return terms.length === 1 ? terms[0] : { op: 'and', terms };
}

export interface ParseBlockStateOptions {
	/**
	 * Called instead of throwing when one case is unusable, so the rest of the
	 * block survives it. AE2's `crafting_monitor` states no model for
	 * `formed=true` because the game draws that state itself — without this,
	 * one such case takes all eleven others with it.
	 */
	onCaseError?: (message: string) => void;
	/** Called when the blockstate parsed, but not as the vanilla format. */
	onNote?: (message: string) => void;
}

/**
 * NeoForge 1.21.6+ lets a mod register a blockstate *definition* loader the way
 * it can register a model loader, and the file then carries the loader's own
 * shape instead of variants. Only the fallback is recoverable from assets:
 * `base_model` is what the block looks like before whatever the loader does at
 * runtime — for FramedBlocks' 233 camouflage blocks, the uncamouflaged cube.
 */
function parseDefinitionLoader(namespace: string, json: object, context: string): BlockStateDefinition | null {
	const entries = json as Record<string, unknown>;
	const loader = Object.entries(entries)
		.find(([name]) => name === 'definition_type' || name.endsWith(':definition_type'))?.[1];
	if (typeof loader !== 'string') {
		return null;
	}
	const base = entries.base_model;
	const model = typeof base === 'string' ? base : (base as { model?: unknown; } | null)?.model;
	if (typeof model !== 'string') {
		throw new BlockStateError(`${context}: definition loader ${loader} states no base_model`);
	}
	return { kind: 'variants', cases: [{ when: {}, apply: parseApply(namespace, { model }, context) }] };
}

/** Parse the cases of one form, dropping unusable ones when tolerated. */
function parseCases<T>(
	entries: Array<[key: string, value: unknown]>,
	build: (key: string, value: unknown) => T,
	context: string,
	options: ParseBlockStateOptions,
): T[] {
	const cases: T[] = [];
	for (const [key, value] of entries) {
		try {
			cases.push(build(key, value));
		} catch (err) {
			if (!options.onCaseError) {
				throw err;
			}
			options.onCaseError((err as Error).message);
		}
	}
	if (cases.length === 0) {
		throw new BlockStateError(`${context}: no usable cases`);
	}
	return cases;
}

/**
 * Parse a blockstate file. `namespace` is the block's own, which is what an
 * unqualified model reference resolves against.
 */
export function parseBlockState(
	namespace: string,
	json: unknown,
	context = namespace,
	options: ParseBlockStateOptions = {},
): BlockStateDefinition {
	if (typeof json !== 'object' || json === null) {
		throw new BlockStateError(`${context}: blockstate is not an object`);
	}
	const { variants, multipart } = json as { variants?: unknown; multipart?: unknown; };
	if (variants !== undefined && multipart !== undefined) {
		throw new BlockStateError(`${context}: states both variants and multipart`);
	}
	if (variants !== undefined) {
		if (typeof variants !== 'object' || variants === null || Array.isArray(variants)) {
			throw new BlockStateError(`${context}: "variants" is not an object`);
		}
		const entries = Object.entries(variants as Record<string, unknown>);
		if (entries.length === 0) {
			throw new BlockStateError(`${context}: empty "variants"`);
		}
		return {
			kind: 'variants',
			cases: parseCases(entries, (key, value) => {
				return {
					when: parseVariantKey(key, context),
					apply: parseApply(namespace, value, `${context} [${key}]`),
				};
			}, context, options),
		};
	}
	if (Array.isArray(multipart)) {
		if (multipart.length === 0) {
			throw new BlockStateError(`${context}: empty "multipart"`);
		}
		return {
			kind: 'multipart',
			cases: parseCases(multipart.map((part, index) => [String(index), part]), (key, value) => {
				const entry = value as { when?: unknown; apply?: unknown; };
				return {
					when: entry.when === undefined ? null : parseCondition(entry.when, `${context} [part ${key}]`),
					apply: parseApply(namespace, entry.apply, `${context} [part ${key}]`),
				};
			}, context, options),
		};
	}
	const viaLoader = parseDefinitionLoader(namespace, json, context);
	if (viaLoader !== null) {
		options.onNote?.('a loader defines this blockstate; exported as its base_model, which is what the block shows before the loader runs');
		return viaLoader;
	}
	throw new BlockStateError(`${context}: states neither variants nor multipart`);
}

/**
 * `absentIsWildcard` is the second pass `evaluateBlockState` makes when the
 * first found nothing: a property the given map does not carry at all counts as
 * satisfied rather than failed. A *wrong* value still fails either way.
 */
export function matchesCondition(
	condition: MultipartCondition,
	properties: BlockProperties,
	absentIsWildcard = false,
): boolean {
	switch (condition.op) {
		case 'match': {
			return Object.entries(condition.properties)
				.every(([name, accepted]) => (absentIsWildcard && properties[name] === undefined) || accepted.includes(properties[name]));
		}
		case 'and': {
			return condition.terms.every(term => matchesCondition(term, properties, absentIsWildcard));
		}
		case 'or': {
			return condition.terms.some(term => matchesCondition(term, properties, absentIsWildcard));
		}
	}
}

/** The variant case closest to an exact-key lookup, or null when none matches. */
function bestVariant<Variant extends { model: string; }>(
	cases: Array<BlockStateVariantCase<Variant>>,
	properties: BlockProperties,
	absentIsWildcard: boolean,
): BlockStateVariantCase<Variant> | null {
	// Variant keys are mutually exclusive in valid data, so at most one matches.
	// Mods do ship overlapping keys; the most constrained one is the closest
	// thing to what an exact-key lookup would have found.
	let best: BlockStateVariantCase<Variant> | null = null;
	for (const variant of cases) {
		const entries = Object.entries(variant.when);
		const matched = entries.every(([name, value]) => properties[name] === value
			|| (absentIsWildcard && properties[name] === undefined));
		if (!matched) {
			continue;
		}
		if (best === null || entries.length > Object.keys(best.when).length) {
			best = variant;
		}
	}
	return best;
}

/**
 * The models the game draws for a block in this state, as one weighted list per
 * contributing part — a fence is several models at once, and each of them may
 * itself be a random pick.
 *
 * When nothing matches, the cases are tried again with any property the given
 * map does not carry treated as a wildcard. That is not tolerance for sloppy
 * data: a world saved before a mod added a property stores the state without it,
 * and Functional Storage's drawers key every case on a `facing` the saves in
 * hand do not have, so a strict read draws a wall of holes. The retry only ever
 * fires where the strict read found nothing, so it cannot change a state that
 * already resolved, and it takes at most one part per model so a block missing
 * its `facing` draws one drawer rather than six rotations of itself.
 *
 * Still empty when even that finds nothing, which is a real answer: a blockstate
 * that covers only some of a block's states draws nothing for the rest.
 */
export function evaluateBlockState<Variant extends { model: string; }>(
	definition: BlockStateDefinition<Variant>,
	properties: BlockProperties,
): Variant[][] {
	if (definition.kind === 'multipart') {
		const matched = definition.cases
			.filter(part => part.when === null || matchesCondition(part.when, properties));
		if (matched.length > 0) {
			return matched.map(part => part.apply);
		}
		const drawn = new Set<string>();
		const loose: Variant[][] = [];
		for (const part of definition.cases) {
			if (part.when !== null && !matchesCondition(part.when, properties, true)) {
				continue;
			}
			const shape = part.apply.map(variant => variant.model).join('|');
			if (drawn.has(shape)) {
				continue;
			}
			drawn.add(shape);
			loose.push(part.apply);
		}
		return loose;
	}
	const best = bestVariant(definition.cases, properties, false)
		?? bestVariant(definition.cases, properties, true);
	return best === null ? [] : [best.apply];
}

/** Every model a blockstate can name, for deciding what to export. */
export function collectModels(definition: BlockStateDefinition): string[] {
	const models = new Set<string>();
	for (const part of definition.cases) {
		for (const variant of part.apply) {
			models.add(variant.model);
		}
	}
	return [...models];
}

const JAVA_MULTIPLIER = 0x5_DE_EC_E6_6Dn;
const JAVA_MASK = (1n << 48n) - 1n;

/**
 * Vanilla's per-position pick from a weighted variant list, so the consumer's
 * grass rotations land where the game puts them instead of somewhere merely
 * deterministic.
 *
 * This is `Mth.getSeed(x, y, z)` seeding a `java.util.Random`, then
 * `WeightedBakedModel`'s `abs((int) nextLong()) % totalWeight`. Both halves are
 * stable across 1.13–1.21.3; 1.21.4 reworked the model system and parity there
 * is unverified, which costs a variant rotation and nothing else.
 */
export function weightedVariantIndex(
	weights: readonly number[],
	blockX: number,
	blockY: number,
	blockZ: number,
): number {
	if (weights.length <= 1) {
		return 0;
	}
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	// Mth.getSeed: the hash the game derives a block position's randomness from.
	let seed = (BigInt(blockX) * 3_129_871n) ^ (BigInt(blockZ) * 116_129_781n) ^ BigInt(blockY);
	seed = seed * seed * 42_317_861n + seed * 11n;
	seed = BigInt.asIntN(64, seed) >> 16n;
	// java.util.Random.setSeed, then one nextLong() (two 32-bit draws).
	let state = (BigInt.asUintN(64, seed) ^ JAVA_MULTIPLIER) & JAVA_MASK;
	const next = (): bigint => {
		state = (state * JAVA_MULTIPLIER + 0xBn) & JAVA_MASK;
		return BigInt.asIntN(32, state >> 16n);
	};
	// nextLong() is two 32-bit draws; truncating it to an int keeps the second.
	next();
	const truncated = Number(next());
	// Java's abs leaves Integer.MIN_VALUE negative, and a negative index makes
	// the weighted walk below stop on its first entry. Same here.
	const picked = (truncated === -2_147_483_648 ? truncated : Math.abs(truncated)) % total;
	let remaining = picked;
	for (const [index, weight] of weights.entries()) {
		remaining -= weight;
		if (remaining < 0) {
			return index;
		}
	}
	return weights.length - 1;
}
