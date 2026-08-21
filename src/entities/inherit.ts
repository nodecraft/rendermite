/**
 * A model class read together with its ancestors.
 *
 * Model code leans on its superclass everywhere. Before 1.17 a model's parts were fields assigned in
 * the constructor and a subclass overrode the two or three it cared about, leaving the rest to
 * `super()`; `CowModel` declares a head with horns and a body, and its four legs belong to
 * `QuadrupedModel`. It did not end with the old API either: 26.2's `PigModel` still starts from
 * `QuadrupedModel.createBodyMesh(6, …)` and only replaces the head.
 *
 * So the interpreter is handed the chain and follows calls into it, arguments and all. What it cannot
 * follow — a builder that loops, a frame past the budget — the name merge below still salvages, one
 * class at a time.
 */

import { parseClassFile } from './classfile.ts';
import { dedupeCubes, mergeModels } from './merge.ts';
import { extractModel } from './model-bytecode.ts';

import type { ClassFile } from './classfile.ts';
import type { ModelCode } from './model-code.ts';
import type { ExtractedModel } from './model.ts';

/** `java/lang/Object` ends the walk; the cap is for a jar whose hierarchy has a cycle in it. */
const MAX_ANCESTORS = 8;

export interface Ancestry {
	/** The class and its ancestors by internal name, parsed. */
	ancestors: Map<string, ClassFile>;
	/** The same classes, most derived first, with the bytes to interpret. */
	chain: Array<{ internalName: string; bytes: Uint8Array; }>;
}

/** Reads a class and everything it inherits from that the jar still holds. */
export async function ancestryOf(
	internalName: string,
	read: (internalName: string) => Promise<Uint8Array | null>,
): Promise<Ancestry> {
	const ancestors = new Map<string, ClassFile>();
	const chain: Array<{ internalName: string; bytes: Uint8Array; }> = [];
	// Slashes throughout, since a mapping names a class with dots and a constant pool with slashes
	let next: string | null = internalName.replaceAll('.', '/');
	for (let depth = 0; next && depth < MAX_ANCESTORS && !ancestors.has(next); depth++) {
		const bytes = await read(next);
		if (!bytes) {
			break;
		}
		let classFile: ClassFile;
		try {
			classFile = parseClassFile(bytes);
		} catch {
			break;
		}
		ancestors.set(next, classFile);
		chain.push({ internalName: next, bytes });
		next = classFile.superClass;
	}
	return { ancestors, chain };
}

/**
 * Geometry for one class, with the code it builds on available and its ancestors' parts filled in.
 *
 * `code` widens what a call may be followed into beyond the ancestors, which some models need: the
 * witch's body is the villager's, and a donkey's chest comes from the saddle model. Without it those
 * models still come out, minus the piece the other class holds.
 *
 * Every ancestor is merged rather than only the first with boxes, because a deep hierarchy splits
 * several ways: 1.16.5's sheep overrides a head in `SheepFurModel` and takes its legs from
 * `QuadrupedModel` two hops up.
 */
export async function extractInheritedModel(
	internalName: string,
	read: (internalName: string) => Promise<Uint8Array | null>,
	code?: ModelCode,
): Promise<ExtractedModel | null> {
	const { ancestors, chain } = await ancestryOf(internalName, read);
	const [own, ...inherited] = chain;
	if (!own) {
		return null;
	}
	const resolve = (name: string): ClassFile | null => ancestors.get(name) ?? code?.resolve(name) ?? null;
	// Without an index there is no telling a renderer from a model, and permissive is the better default
	const following = (name: string): boolean => !code || code.resolve(name) !== null;
	let model = extractModel(own.bytes, { resolve, isModelCode: following(own.internalName) });
	for (const ancestor of inherited) {
		const inheritedModel = extractModel(ancestor.bytes, {
			resolve,
			isModelCode: following(ancestor.internalName),
		});
		model = mergeModels(model, inheritedModel);
	}
	// Last, so it catches a duplicate that only became one once an ancestor's parts were merged in
	return dedupeCubes(model);
}
