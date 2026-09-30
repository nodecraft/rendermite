/**
 * Where a block's own class answers a question itself, rather than leaving it to its `Properties`.
 *
 * Some of what a block does is a method override, not a builder call: a stair or a slab tests its
 * shape for light (`useShapeForLightOcclusion`), tinted glass stops all light (`getLightBlock`), kelp is
 * always under water (`getFluidState`), and before 1.16.2 an air block said so by overriding `isAir`.
 * The override is found by walking the block's class chain for a method of that original name, and it
 * only counts where a class below the base declares it: the base's own is the default answer.
 */

import { instructions } from './entity-sizes.ts';

import type { MemberReference } from './light-bytecode.ts';
import type { ClassFile } from '../entities/classfile.ts';

export interface OverrideSource {
	resolve: (internalName: string) => ClassFile | null;
	/** A member's original name, for a jar that spells the game's own obfuscated. */
	nameOf: (reference: MemberReference, field: boolean) => string;
}

/** `getstatic`, `invokevirtual` and `invokeinterface`: the instructions whose target says what code reads. */
const READS = new Set([0xB2, 0xB6, 0xB9]);

/** How far up a block's class chain to look; vanilla's deepest is well under this. */
const MAX_DEPTH = 16;

/** The nearest override of one of `names` above `blockType`, or null where only the base declares it. */
export function overrideOf(source: OverrideSource, blockType: string, names: readonly string[]): MemberReference | null {
	const declarations: MemberReference[] = [];
	let at = source.resolve(blockType);
	for (let depth = 0; at && depth < MAX_DEPTH; depth++) {
		const owner = at.thisClass;
		const method = at.methods.find(candidate => candidate.code
			&& names.includes(source.nameOf({ owner, name: candidate.name, descriptor: candidate.descriptor }, false)));
		if (method) {
			declarations.push({ owner, name: method.name, descriptor: method.descriptor });
		}
		at = at.superClass ? source.resolve(at.superClass) : null;
	}
	// The topmost declaration is the base's default; anything below it is the block answering for itself
	return declarations.length > 1 ? declarations[0] : null;
}

/**
 * The constants an override reads, by original name, and whether it reads a block property: enough to
 * answer from its code without running it. Kelp's `getFluidState` reads `Fluids.WATER` and nothing
 * else; a barrier's `getRenderShape` reads `RenderShape.INVISIBLE`. One that reads a property
 * (`waterlogged`) answers per state, which the state already says.
 */
export function constantsReadBy(source: OverrideSource, method: MemberReference): { statics: Set<string>; readsState: boolean; } | null {
	const classFile = source.resolve(method.owner);
	const code = classFile?.methods.find(candidate => candidate.name === method.name && candidate.descriptor === method.descriptor)?.code;
	if (!classFile || !code) {
		return null;
	}
	const statics = new Set<string>();
	let readsState = false;
	for (const { op, index } of instructions(code)) {
		const reference = READS.has(op) ? classFile.reference(index) : null;
		if (!reference) {
			continue;
		}
		const name = source.nameOf(reference, op === 0xB2);
		if (op === 0xB2) {
			statics.add(name);
		} else if (name === 'getValue') {
			readsState = true;
		}
	}
	return { statics, readsState };
}

/** The fluid an override of `getFluidState` holds in every state, or null where it depends on one. */
export function constantFluidOf(source: OverrideSource, method: MemberReference): 'water' | 'lava' | null {
	const read = constantsReadBy(source, method);
	if (!read || read.readsState) {
		return null;
	}
	if (read.statics.has('WATER')) {
		return 'water';
	}
	return read.statics.has('LAVA') ? 'lava' : null;
}

/** Whether an override of `getRenderShape` always answers `INVISIBLE`, as a barrier's and a light block's do. */
export function alwaysInvisible(source: OverrideSource, method: MemberReference): boolean {
	const read = constantsReadBy(source, method);
	return read !== null && !read.readsState && read.statics.has('INVISIBLE') && !read.statics.has('MODEL');
}
