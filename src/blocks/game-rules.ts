/**
 * The version's game rules: each one's name, whether it is on/off or a number, and its default.
 *
 * Rules are registered in `GameRules.<clinit>` and nowhere else, in three shapes over the years:
 *
 * - 1.13: `put("doFireTick", new Value("true", BOOLEAN_VALUE))`, the default a string.
 * - 1.14–1.21: `register("doFireTick", UPDATES, BooleanValue.create(true))`.
 * - 26.x: `registerBoolean("fire_spread_radius…", UPDATES, true)`, with the names now snake_case.
 *
 * All three push the name, then the default, then call something taking a `boolean` or an `int`, so a
 * linear pass reads them without interpreting anything. The default is the *first* constant after
 * the name because 26.x writes some as `DEBUG ? false : true`, whose second constant is the other arm.
 */

import { instructions } from './entity-sizes.ts';
import { parseClassFile } from '../entities/classfile.ts';
import { readAhead } from '../resources/read-ahead.ts';

import type { ClassFile } from '../entities/classfile.ts';
import type { ClassSource } from '../entities/jar-classes.ts';

export interface GameRule {
	type: 'boolean' | 'integer';
	default: boolean | number;
}

/** `game-rules.json`: rule name, exactly as `level.dat` stores it, to its type and default. */
export type GameRulePack = Record<string, GameRule>;

/** A rule every version has, spelled either way, to find the class that registers them. */
const MARKERS = new Set(['keepInventory', 'keep_inventory']);

function isRuleName(text: string): boolean {
	return /^[a-z]\w*$/.test(text) && text.length < 64;
}

/** The first `boolean` or `int` a descriptor takes, which is the kind of value it was handed. */
function valueKind(descriptor: string): GameRule['type'] | null {
	const args = descriptor.slice(1, descriptor.indexOf(')')).replaceAll(/L[^;]+;/g, 'L');
	if (args.includes('Z')) {
		return 'boolean';
	}
	return args.includes('I') ? 'integer' : null;
}

/**
 * Every class naming a rule is a candidate, since a data fixer that renames them names them too; the
 * one whose initialiser registers the most is the registry. Raw bytes are searched before anything is
 * parsed, which keeps this to a handful of classes out of ten thousand.
 */
export async function collectGameRules(classes: ClassSource): Promise<GameRulePack> {
	let best: GameRulePack = {};
	for (const [, pending] of readAhead(await classes.list(), internal => classes.read(internal))) {
		const bytes = await pending;
		if (!bytes || ![...MARKERS].some(marker => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes(marker))) {
			continue;
		}
		let classFile: ClassFile;
		try {
			classFile = parseClassFile(bytes);
		} catch {
			continue;
		}
		const rules = rulesRegisteredBy(classFile);
		if (Object.keys(rules).length > Object.keys(best).length) {
			best = rules;
		}
	}
	return best;
}

/** Rules registered anywhere in the class: `<clinit>`, or the lambda 1.13 fills its map from. */
function rulesRegisteredBy(owner: ClassFile): GameRulePack {
	const rules: GameRulePack = {};
	for (const method of owner.methods) {
		if (method.code) {
			Object.assign(rules, rulesIn(owner, method.code));
		}
	}
	return rules;
}

function rulesIn(owner: ClassFile, code: Uint8Array): GameRulePack {
	const rules: GameRulePack = {};
	let name: string | null = null;
	let first: number | string | null = null;
	for (const { op, index } of instructions(code)) {
		let constant: number | string | null = null;
		if (op >= 0x02 && op <= 0x08) {
			constant = op - 0x03;
		} else if (op === 0x10 || op === 0x11) {
			// bipush / sipush: the operand is the value, which `instructions` leaves in `index`
			constant = op === 0x10 ? (index >> 8) << 24 >> 24 : index << 16 >> 16;
		} else if (op === 0x12 || op === 0x13) {
			const literal = owner.literal(index);
			if (typeof literal === 'string' && (literal === 'true' || literal === 'false' || /^-?\d+$/.test(literal))) {
				constant = literal;
			} else if (typeof literal === 'string' && isRuleName(literal)) {
				name = literal;
				first = null;
				continue;
			} else if (typeof literal === 'number') {
				constant = literal;
			}
		}
		if (constant !== null) {
			first ??= constant;
			if (name && typeof constant === 'string') {
				// 1.13 states the default as text, and the text is the type
				rules[name] = constant === 'true' || constant === 'false'
					? { type: 'boolean', default: constant === 'true' }
					: { type: 'integer', default: Number(constant) };
				name = null;
			}
			continue;
		}
		if ((op === 0xB8 || op === 0xB7) && name && first !== null) {
			const call = owner.reference(index);
			const kind = call ? valueKind(call.descriptor) : null;
			if (kind) {
				rules[name] = kind === 'boolean' ? { type: 'boolean', default: first !== 0 } : { type: 'integer', default: Number(first) };
				name = null;
			}
		}
	}
	return rules;
}
