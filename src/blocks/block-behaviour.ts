/**
 * What a block *does*, read off the `Properties` its registration built: how hard it is, whether an
 * entity collides with it, whether it can be built over, which colour it is on a map.
 *
 * None of this is in an asset. It is the builder chain in `Blocks.<clinit>` — `strength(1.5F, 6F)`,
 * `noCollission()`, `replaceable()`, `mapColor(MapColor.STONE)` — so it comes out of the same
 * interpretation that reads light (see `light-bytecode.ts`), which records every builder call it
 * passes. Before 1.20 half of it lived on the block's `Material` instead, whose flags this reads off
 * the constant the registration named.
 *
 * Only what the calls say is written. A block class that overrides `canBeReplaced` or `getMapColor`
 * in code answers for itself at runtime, and that is not followed.
 */

import type {
	Handle,
	LightExtraction,
	Registration,
	Value,
} from './light-bytecode.ts';
import type { BlockPackLight } from './pack-format.ts';

/** How pistons treat a block; absent means `normal`, pushed and pulled like stone. */
export type PushReactionName = 'destroy' | 'block' | 'ignore' | 'push_only';

export interface BlockBehaviour {
	/** Seconds-ish to mine by hand, as `destroyTime`; `-1` is unbreakable. */
	hardness: number;
	/** Explosion resistance. */
	resistance: number;
	/**
	 * Map colour id (0–63, 0 draws nothing). A number, or per-state cases in the shape `light.json`
	 * uses: a log is one colour on its end grain and another on its bark.
	 */
	mapColor?: BlockPackLight;
	/** Entities walk through it: grass, flowers, torches. */
	collision?: false;
	/** It hides nothing behind it: glass, leaves, anything `noOcclusion()`. */
	occludes?: false;
	/** A placed block or a growing tree takes its place without breaking it. */
	replaceable?: true;
	air?: true;
	liquid?: true;
	/** Lava sets it alight (`ignitedByLava`, or a flammable `Material` before 1.20). */
	flammable?: true;
	pushReaction?: PushReactionName;
	/** Drops nothing unless mined with the right tool. */
	requiresTool?: true;
	randomTicks?: true;
	friction?: number;
	speedFactor?: number;
	jumpFactor?: number;
}

const PUSH_REACTIONS = new Set<string>(['destroy', 'block', 'ignore', 'push_only']);

function num(value: Value | undefined): number | null {
	return value?.kind === 'number' ? value.value : null;
}

function field(handle: Handle, name: string): Value | undefined {
	return handle.fields.get(`mapped:${name}`) ?? handle.fields.get(name);
}

/** A `MapColor` (`MaterialColor` before 1.20) is constructed as `(id, rgb)`; its id is the first. */
function mapColorId(value: Value | undefined): number | null {
	if (value?.kind !== 'object') {
		return null;
	}
	const args = value.handle.ctorArgs ?? [];
	const id = num(args[0]);
	if (args.length === 2 && id !== null && num(args[1]) !== null && id >= 0 && id < 64) {
		return id;
	}
	// A `DyeColor`: an enum, constructed `(name, ordinal, …)`, handed its map colour among the rest
	if (args[0]?.kind !== 'string' || args[1]?.kind !== 'number') {
		return null;
	}
	for (const arg of args) {
		const nested = arg.kind === 'object' && arg.handle !== value.handle ? mapColorId(arg) : null;
		if (nested !== null) {
			return nested;
		}
	}
	return null;
}

/** An enum constant's serialized name: the lower-cased constant name it was constructed with. */
function enumName(value: Value | undefined): string | null {
	const name = value?.kind === 'object' ? value.handle.ctorArgs?.[0] : undefined;
	return name?.kind === 'string' ? name.value.toLowerCase() : null;
}

/** The chain of `Properties` a block's came from, oldest copy first, so later calls win. */
function lineage(props: Handle): Handle[] {
	const chain: Handle[] = [];
	for (let at: Handle | null | undefined = props; at && !chain.includes(at); at = at.copyOf) {
		chain.unshift(at);
	}
	return chain;
}

/** The `Material` a pre-1.20 `Properties` was constructed with, when it was. */
function materialOf(props: Handle): Handle | null {
	for (const handle of lineage(props)) {
		for (const arg of handle.ctorArgs ?? []) {
			if (arg.kind === 'object' && field(arg.handle, 'replaceable') !== undefined) {
				return arg.handle;
			}
		}
	}
	return null;
}

/**
 * The colour a block's `Properties` state: a `mapColor` call, the colour a pre-1.20 `Properties` was
 * constructed with, or its `Material`'s, latest first. A constant or a function of state.
 */
export function statedMapColor(props: Handle): Value | undefined {
	const material = materialOf(props);
	let colour = material ? field(material, 'color') : undefined;
	for (const handle of lineage(props)) {
		colour = (handle.ctorArgs ?? []).find(arg => arg.kind === 'lambda' || mapColorId(arg) !== null) ?? colour;
		for (const call of handle.calls ?? []) {
			if (call.name === 'mapColor') {
				colour = call.args[0];
			}
		}
	}
	return colour;
}

/** A float as Java wrote it: `0.3F` is 0.30000001192092896 as a double, and 0.3 is what the code says. */
function float32(value: number): number {
	for (let digits = 1; digits < 10; digits++) {
		const candidate = Number(value.toPrecision(digits));
		if (Math.fround(candidate) === Math.fround(value)) {
			return candidate;
		}
	}
	return value;
}

export function blockBehaviour(
	registration: Registration,
	extraction: Pick<LightExtraction, 'tabulate'>,
): { behaviour: BlockBehaviour; failures: string[]; } | null {
	const props = registration.props;
	if (!props) {
		return null;
	}
	const failures: string[] = [];
	const behaviour: BlockBehaviour = { hardness: 0, resistance: 0 };
	const mapColor = statedMapColor(props);

	const material = materialOf(props);
	if (material) {
		// The flags the `Material` answered for before 1.20 split them out onto `Properties`
		if (num(field(material, 'replaceable')) === 1) {
			behaviour.replaceable = true;
		}
		if (num(field(material, 'liquid')) === 1) {
			behaviour.liquid = true;
		}
		if (num(field(material, 'flammable')) === 1) {
			behaviour.flammable = true;
		}
		// 1.14 and 1.15, before `requiresCorrectToolForDrops`: a material that is not always destroyable needs a tool
		if (num(field(material, 'alwaysDestroyable')) === 0) {
			behaviour.requiresTool = true;
		}
		const reaction = enumName(field(material, 'pushReaction'));
		if (reaction && PUSH_REACTIONS.has(reaction)) {
			behaviour.pushReaction = reaction as PushReactionName;
		}
	}
	for (const handle of lineage(props)) {
		for (const call of handle.calls ?? []) {
			const [first, second] = call.args;
			switch (call.name) {
				case 'strength': {
					behaviour.hardness = float32(num(first) ?? behaviour.hardness);
					behaviour.resistance = float32(num(second ?? first) ?? behaviour.resistance);
					break;
				}
				case 'destroyTime': {
					behaviour.hardness = float32(num(first) ?? behaviour.hardness);
					break;
				}
				case 'explosionResistance': {
					behaviour.resistance = float32(num(first) ?? behaviour.resistance);
					break;
				}
				case 'instabreak': {
					behaviour.hardness = 0;
					behaviour.resistance = 0;
					break;
				}
				case 'noCollission':
				case 'noCollision': {
					behaviour.collision = false;
					behaviour.occludes = false;
					break;
				}
				case 'noOcclusion': {
					behaviour.occludes = false;
					break;
				}
				case 'replaceable': {
					behaviour.replaceable = true;
					break;
				}
				case 'air': {
					behaviour.air = true;
					break;
				}
				case 'liquid': {
					behaviour.liquid = true;
					break;
				}
				case 'ignitedByLava': {
					behaviour.flammable = true;
					break;
				}
				case 'requiresCorrectToolForDrops': {
					behaviour.requiresTool = true;
					break;
				}
				case 'randomTicks': {
					behaviour.randomTicks = true;
					break;
				}
				case 'pushReaction': {
					const reaction = enumName(first);
					if (reaction === 'normal') {
						delete behaviour.pushReaction;
					} else if (reaction && PUSH_REACTIONS.has(reaction)) {
						behaviour.pushReaction = reaction as PushReactionName;
					}
					break;
				}
				case 'friction':
				case 'speedFactor':
				case 'jumpFactor': {
					const value = num(first);
					if (value !== null) {
						behaviour[call.name] = float32(value);
					}
					break;
				}
			}
		}
	}

	if (mapColor?.kind === 'lambda') {
		const folded = extraction.tabulate(mapColor, mapColorId);
		if ('failure' in folded) {
			failures.push(`map colour: ${folded.failure}`);
		} else {
			behaviour.mapColor = folded.value;
		}
	} else if (mapColor !== undefined) {
		const id = mapColorId(mapColor);
		if (id === null) {
			failures.push('map colour is a value the interpreter could not identify');
		} else {
			behaviour.mapColor = id;
		}
	}
	return { behaviour, failures };
}
