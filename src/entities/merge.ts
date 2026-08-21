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

type Vec3 = readonly [number, number, number];

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

/**
 * Drops boxes that land exactly where one already is.
 *
 * A model builder's branches are all taken, because they turn on a constructor argument this cannot
 * know — a `CubeDeformation`, a baby-variant flag — so a model that builds one shape *or* another
 * emits both. Where the two arms differ, that is the honest answer and the model says so in a note.
 * Where they agree, it is four legs drawn twice in the same place: `HorseModel` builds
 * `left_hind_leg` and `left_hind_baby_leg` at identical coordinates, and two coplanar boxes are
 * exactly what z-fighting is.
 *
 * Keyed on the accumulated pivot and rotation rather than on evaluated corners, since duplicates come
 * from one builder running twice and land on identical frames. The first is kept: a builder states the
 * ordinary shape before the variant.
 */
export function dedupeCubes(model: ExtractedModel): ExtractedModel {
	const seen = new Set<string>();
	const round = (value: number): string => value.toFixed(4);
	const walk = (part: Part, pivot: Vec3, rotation: Vec3): Part => {
		const at: Vec3 = [pivot[0] + part.pivot[0], pivot[1] + part.pivot[1], pivot[2] + part.pivot[2]];
		const spun: Vec3 = [
			rotation[0] + part.rotation[0],
			rotation[1] + part.rotation[1],
			rotation[2] + part.rotation[2],
		];
		const cubes = part.cubes.filter((cube) => {
			const key = [
				...at.map(round),
				...spun.map(round),
				...cube.origin.map(round),
				...cube.size.map(round),
				...cube.uv.map(round),
				round(cube.inflate),
			].join('|');
			if (seen.has(key)) {
				return false;
			}
			seen.add(key);
			return true;
		});
		const children = part.children
			.map(child => walk(child, at, spun))
			// A part whose only box was a duplicate, with nothing under it, is not geometry any more
			.filter(child => child.cubes.length > 0 || child.children.length > 0);
		return { ...part, cubes, children };
	};
	return {
		...model,
		parts: model.parts
			.map(part => walk(part, [0, 0, 0], [0, 0, 0]))
			.filter(part => part.cubes.length > 0 || part.children.length > 0),
	};
}

export function countCubes(part: Part): number {
	return part.cubes.length + part.children.reduce((total, child) => total + countCubes(child), 0);
}

export function cubesOf(model: ExtractedModel): number {
	return model.parts.reduce((total, part) => total + countCubes(part), 0);
}
