/**
 * Each entity type's hitbox, read out of the code that registers it.
 *
 * `EntityType.Builder.of(Cow::new, CREATURE).sized(0.9F, 1.4F)` is the only place a cow's size is
 * stated, so a consumer drawing a stand-in box for a mob either reads it here or hardcodes a table
 * that is a release behind. The two floats are always pushed right before the call, and the name is
 * a string near it: before it in vanilla's `register("cow", …)`, after it in a mod's
 * `build("name")`, or before the lambda a `DeferredRegister.register("name", () -> …)` was handed.
 * A linear pass over each method finds all three without interpreting anything.
 *
 * 1.13 has no builder size (a mob set its own in its constructor) and no mappings to read the call by,
 * so it gets none. Sizes are the base ones: a baby or a large slime scales its own at runtime.
 */

import { parseClassFile } from '../entities/classfile.ts';
import { MappingsUnavailableError, resolveMappings } from '../entities/mappings.ts';

import type { ClassFile } from '../entities/classfile.ts';
import type { ClassSource } from '../entities/jar-classes.ts';
import type { Mappings } from '../entities/mappings.ts';

/**
 * `sized` by every name a jar can call it: Mojang's (vanilla, NeoForge), Forge's SRG name, and
 * Fabric's intermediary one, since a mod jar keeps whichever its loader compiles against.
 */
const SIZED_NAMES = new Set(['sized', 'm_20699_', 'method_17687']);

/** Operand bytes after each opcode that has a fixed number, for walking a method without decoding it. */
const OPERANDS = new Map<number, number>([
	[0x10, 1],
	[0x12, 1],
	[0x15, 1],
	[0x16, 1],
	[0x17, 1],
	[0x18, 1],
	[0x19, 1],
	[0x36, 1],
	[0x37, 1],
	[0x38, 1],
	[0x39, 1],
	[0x3A, 1],
	[0xA9, 1],
	[0xBC, 1],
	[0x11, 2],
	[0x13, 2],
	[0x14, 2],
	[0x84, 2],
	[0xA7, 2],
	[0xA8, 2],
	[0xC6, 2],
	[0xC7, 2],
	[0xB2, 2],
	[0xB3, 2],
	[0xB4, 2],
	[0xB5, 2],
	[0xB6, 2],
	[0xB7, 2],
	[0xB8, 2],
	[0xBB, 2],
	[0xBD, 2],
	[0xC0, 2],
	[0xC1, 2],
	[0xC5, 3],
	[0xB9, 4],
	[0xBA, 4],
	[0xC8, 4],
	[0xC9, 4],
]);

interface Instruction {
	op: number;
	/** The pool index a two-byte operand names, for the loads and invokes this reads. */
	index: number;
}

/** Every instruction of a method, in order. */
export function *instructions(code: Uint8Array): Generator<Instruction> {
	let at = 0;
	while (at < code.length) {
		const op = code[at];
		const start = at;
		at++;
		if (op >= 0x99 && op <= 0xA6) {
			at += 2;
		} else if (op === 0xAA || op === 0xAB) {
			// tableswitch / lookupswitch, padded to a four-byte boundary from the opcode
			at += (4 - (at % 4)) % 4;
			const read = (offset: number): number => ((code[offset] << 24) | (code[offset + 1] << 16) | (code[offset + 2] << 8) | code[offset + 3]);
			if (op === 0xAA) {
				const low = read(at + 4);
				const high = read(at + 8);
				at += 12 + (high - low + 1) * 4;
			} else {
				at += 8 + read(at + 4) * 8;
			}
		} else if (op === 0xC4) {
			// wide: a load, store or `ret` with a two-byte index, or an `iinc` with two two-byte operands
			at += code[at] === 0x84 ? 5 : 3;
		} else {
			at += OPERANDS.get(op) ?? 0;
		}
		const index = op === 0x12 ? code[start + 1] : ((code[start + 1] << 8) | code[start + 2]);
		yield { op, index };
	}
}

function looksLikeId(text: string): boolean {
	return /^[a-z0-9_.\-/]+(?::[a-z0-9_.\-/]+)?$/.test(text) && text.length < 128;
}

export interface EntitySizeResult {
	/** Entity id → [width, height], in blocks. */
	sizes: Map<string, [number, number]>;
	failures: Array<{ id: string; reason: string; }>;
}

/** A float as Java wrote it: `0.6F` widens to 0.6000000238418579, and 0.6 is what the code says. */
function float32(value: number): number {
	for (let digits = 1; digits < 10; digits++) {
		const candidate = Number(value.toPrecision(digits));
		if (Math.fround(candidate) === Math.fround(value)) {
			return candidate;
		}
	}
	return value;
}

export async function collectEntitySizes(options: {
	classes: ClassSource;
	version: string;
	cacheDir: string;
	entityIds: readonly string[];
}): Promise<EntitySizeResult> {
	const sizes = new Map<string, [number, number]>();
	const failures: EntitySizeResult['failures'] = [];
	const names = await options.classes.list();
	let mappings: Mappings;
	try {
		({ mappings } = await resolveMappings(options.version, options.cacheDir, async () => names));
	} catch (err) {
		if (!(err instanceof MappingsUnavailableError)) {
			throw err;
		}
		failures.push({ id: options.version, reason: `no entity sizes: ${err.message}` });
		return { sizes, failures };
	}
	const originalName = (owner: string, name: string, descriptor: string): string => mappings.nameOf?.get(`${owner.replaceAll('/', '.')}.${name}${descriptor}`) ?? name;

	const parsed: ClassFile[] = [];
	for (const name of names) {
		const bytes = await options.classes.read(name);
		if (!bytes) {
			continue;
		}
		try {
			parsed.push(parseClassFile(bytes));
		} catch {
			// A class this parser cannot read registers nothing it could have found anyway
		}
	}

	/*
	 * Names that are not strings where the size is: 26.x registers `EntityTypeIds.COW`, a key another
	 * class's `<clinit>` built from `"cow"`, and a mod hands `register("name", () -> …)` a lambda whose
	 * body never sees the name. Both are the string last pushed before a `putstatic` of a key or an
	 * `invokedynamic`, collected before any size is read.
	 */
	const keyNames = new Map<string, string>();
	const lambdaNames = new Map<string, string>();
	for (const classFile of parsed) {
		for (const method of classFile.methods) {
			if (!method.code) {
				continue;
			}
			let last: string | null = null;
			for (const { op, index } of instructions(method.code)) {
				if (op === 0x12 || op === 0x13) {
					const literal = classFile.literal(index);
					if (typeof literal === 'string' && looksLikeId(literal)) {
						last = literal;
					}
				} else if (op === 0xB3 && last !== null && method.name === '<clinit>') {
					const field = classFile.reference(index);
					// A registry key, not any constant made from a string: `MobCategory.CREATURE` is `"creature"` too
					if (field && /ResourceKey;$|^Ljava\/lang\/String;$/.test(field.descriptor)) {
						keyNames.set(`${field.owner}.${field.name}`, last);
					}
					last = null;
				} else if (op === 0xBA && last !== null) {
					const target = classFile.lambdaTarget(index);
					if (target) {
						lambdaNames.set(`${target.owner}.${target.name}${target.descriptor}`, last);
					}
				}
			}
		}
	}

	// Bare names, to the ids the pack actually has: a mod's `zombie` must not answer for vanilla's
	const idsByPath = new Map<string, string[]>();
	for (const id of options.entityIds) {
		const path = id.slice(id.indexOf(':') + 1);
		idsByPath.set(path, [...idsByPath.get(path) ?? [], id]);
	}
	const vanillaClass = (name: string): boolean => name.startsWith('net/minecraft/') || mappings.originalOf.has(name.replaceAll('/', '.'));
	const resolveId = (name: string, owner: string): string | null => {
		if (name.includes(':')) {
			return options.entityIds.includes(name) ? name : null;
		}
		const candidates = idsByPath.get(name) ?? [];
		const vanilla = vanillaClass(owner);
		return candidates.find(id => id.startsWith('minecraft:') === vanilla) ?? null;
	};

	for (const classFile of parsed) {
		for (const method of classFile.methods) {
			if (!method.code) {
				continue;
			}
			let last: string | null = lambdaNames.get(`${classFile.thisClass}.${method.name}${method.descriptor}`) ?? null;
			const floats: number[] = [];
			let pending: [number, number] | null = null;
			const settle = (name: string): void => {
				const id = pending && resolveId(name, classFile.thisClass);
				if (pending && id && !sizes.has(id)) {
					sizes.set(id, [float32(pending[0]), float32(pending[1])]);
				}
				pending = null;
			};
			for (const { op, index } of instructions(method.code)) {
				if (op >= 0x0B && op <= 0x0D) {
					floats.push(op - 0x0B);
				} else if (op === 0x12 || op === 0x13) {
					const literal = classFile.literal(index);
					if (typeof literal === 'number' && classFile.constants[index]?.tag === 'float') {
						floats.push(literal);
					} else if (typeof literal === 'string' && looksLikeId(literal)) {
						// A mod names the type after its size, in `build("name")`
						if (pending) {
							settle(literal);
						}
						last = literal;
					}
				} else if (op === 0xB2) {
					const field = classFile.reference(index);
					const key = field && keyNames.get(`${field.owner}.${field.name}`);
					if (key) {
						last = key;
					}
				} else if (op === 0xB6 || op === 0xB9) {
					const call = classFile.reference(index);
					if (call && call.descriptor.startsWith('(FF)') && SIZED_NAMES.has(originalName(call.owner, call.name, call.descriptor)) && floats.length >= 2) {
						pending = [floats.at(-2) as number, floats.at(-1) as number];
						if (last !== null) {
							settle(last);
						}
					}
				}
			}
		}
	}
	return { sizes, failures };
}
