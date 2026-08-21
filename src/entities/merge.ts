/**
 * Folding two pieces of one model together, by part name.
 *
 * Needed twice, for the same reason: a model is rarely built in one place. `QuadrupedModel` puts its
 * head and body in `createBodyMesh` and its four legs in `createLegs`, and `CowModel` overrides the
 * head and body while leaving the legs to its superclass. Either way the pieces address the same parts,
 * so the name decides: the piece nearer the concrete model wins, and a name it never mentions can only
 * have come from the other.
 */

import type { ExtractedModel, Part } from './model.ts';

/** A root the interpreter had to invent, because a `MeshDefinition`'s root part is anonymous. */
const SYNTHETIC_ROOT = /^part\d+$/;

/**
 * Where a piece's parts sit: at the top, or inside the one anonymous root a `MeshDefinition` makes.
 * Both merge into the same list of named slots and only one of them is nested.
 */
export function slotsOf(parts: Part[]): { container: Part | null; slots: Part[]; } {
	const [only] = parts;
	if (parts.length === 1 && only.cubes.length === 0 && SYNTHETIC_ROOT.test(only.name)) {
		return { container: only, slots: only.children };
	}
	return { container: null, slots: parts };
}

/** True when this piece built its own mesh rather than adding to one it was handed. */
export function buildsOwnMesh(model: ExtractedModel): boolean {
	return slotsOf(model.parts).container !== null;
}

/** `base` plus the parts of `extra` that `base` does not name. */
export function mergeModels(base: ExtractedModel, extra: ExtractedModel): ExtractedModel {
	const target = slotsOf(base.parts);
	const source = slotsOf(extra.parts);
	const named = new Set(target.slots.map(part => part.name));
	const missing = source.slots.filter(part => !named.has(part.name));
	if (missing.length === 0) {
		return base;
	}
	const parts = target.container
		? [{ ...target.container, children: [...target.container.children, ...missing] }]
		: [...target.slots, ...missing];
	/*
	 * A disconnected-roots note describes a model that came out in pieces, so it has no business
	 * surviving onto one that did not: a merge that leaves a single root has answered it.
	 */
	const notes = [...new Set([...base.notes, ...extra.notes])]
		.filter(note => parts.length > 1 || !note.includes('disconnected roots'));
	return {
		// A piece that never states its own sheet size takes the other's
		textureSize: base.textureSize[0] === 64 && base.textureSize[1] === 32 ? extra.textureSize : base.textureSize,
		parts,
		notes,
	};
}

export function countCubes(part: Part): number {
	return part.cubes.length + part.children.reduce((total, child) => total + countCubes(child), 0);
}

export function cubesOf(model: ExtractedModel): number {
	return model.parts.reduce((total, part) => total + countCubes(part), 0);
}
