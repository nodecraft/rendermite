/**
 * Bedrock `.geo.json` geometry, converted into the same model a Java class produces.
 *
 * GeckoLib mods do not write their models in Java at all: they ship Blockbench's bedrock format and
 * register it by resource location, so the bytecode interpreter finds nothing to read. On a corpus of
 * four GeckoLib mods that is 135 geometry files, and on a real modpack it is most of what the bytecode
 * path cannot reach.
 *
 * ## The two spaces
 *
 * A `ModelPart` is authored in a space where **y runs downwards from 1.5 blocks above the mob's feet**,
 * because `LivingEntityRenderer` draws the model through `scale(-1, -1, 1)` after translating down by
 * 1.501 blocks. So a model point `p` lands at world `(-p.x / 16, 1.5 - p.y / 16, p.z / 16)`.
 *
 * Bedrock geometry is authored **y up from the feet** and mirrored in x the same way — which is why
 * `geoToFaces` negates x and nothing else to draw one. So a bedrock point `b` lands at world
 * `(-b.x / 16, b.y / 16, b.z / 16)`, and the whole conversion is `y → 24 - y`:
 *
 *     java = [b.x, 24 - b.y, b.z]
 *
 * Checkable against the game rather than taken on trust. Creeper Overhaul's creepers keep vanilla's
 * skeleton: its legs pivot at bedrock y 6, and a vanilla creeper's legs pivot at 18. 24 - 6 = 18.
 *
 * The flip is a mirror, so it reverses two of the three rotations. Conjugating by `diag(1, -1, 1)`
 * negates the rotations about x and z; bedrock's own convention (which `geoToFaces` implements) already
 * negates the ones about x and y, so the two compose to `[r.x, -r.y, -r.z]` in radians. That is not
 * taken on trust either: `test/entity-geo.test.ts` sweeps all eight sign combinations against the
 * evaluator that draws these models in production, and this is the only one that agrees.
 */

import type {
	Cube,
	CubeFace,
	ExtractedModel,
	Part,
} from './model.ts';
import type { ParsedGeo } from '../render/geo.ts';

/** Where a `ModelPart`'s origin sits above the feet, in pixels: 1.5 blocks. */
const FEET = 24;

const DEGREES = Math.PI / 180;

/** A cycle in `parent` links would otherwise walk forever; no real model nests anywhere near this. */
const MAX_DEPTH = 32;

interface GeoBoneLike {
	name?: string;
	parent?: string;
	pivot?: number[];
	rotation?: number[];
	cubes?: GeoCubeLike[];
}

interface GeoCubeLike {
	origin?: number[];
	size?: number[];
	uv?: number[] | Record<string, { uv: number[]; uv_size?: number[]; }>;
	inflate?: number;
	mirror?: boolean;
	pivot?: number[];
	rotation?: number[];
}

const vec3 = (values: number[] | undefined): [number, number, number] => [values?.[0] ?? 0, values?.[1] ?? 0, values?.[2] ?? 0];

/** A bedrock point in `ModelPart` space. */
const toJava = (point: [number, number, number]): [number, number, number] => [point[0], FEET - point[1], point[2]];

/** `-0` is what negating an unrotated bone leaves behind, and it has no business in a pack file. */
const noMinusZero = (value: number): number => (value === 0 ? 0 : value);

const toJavaRotation = (rotation: number[] | undefined): [number, number, number] => {
	const [pitch, yaw, roll] = vec3(rotation);
	return [noMinusZero(pitch * DEGREES), noMinusZero(-yaw * DEGREES), noMinusZero(-roll * DEGREES)];
};

const FACES: CubeFace[] = ['north', 'south', 'east', 'west', 'up', 'down'];

/** Bedrock's per-face rects, which have no equivalent in a Java box unwrap. */
function faceRects(cube: GeoCubeLike, size: [number, number, number]): Cube['faces'] {
	if (!cube.uv || Array.isArray(cube.uv)) {
		return undefined;
	}
	const faces: NonNullable<Cube['faces']> = {};
	for (const face of FACES) {
		const entry = cube.uv[face];
		if (entry?.uv) {
			faces[face] = {
				uv: [entry.uv[0], entry.uv[1]],
				// Bedrock defaults an omitted `uv_size` to the face's own pixel extent
				size: [entry.uv_size?.[0] ?? size[0], entry.uv_size?.[1] ?? size[1]],
			};
		}
	}
	return Object.keys(faces).length > 0 ? faces : undefined;
}

/**
 * One bedrock cube, in the space of the part that owns it.
 *
 * `pivot` is the *bone's* pivot in bedrock space: a cube's box is stated in absolute coordinates, and a
 * `ModelPart`'s is stated relative to where the part pivots. The y flip swaps which corner is the
 * minimum, so the origin is measured from the far side of the box.
 */
function toCube(cube: GeoCubeLike, pivot: [number, number, number]): Cube | null {
	// eslint-disable-next-line unicorn/explicit-length-check -- `size` is a Vec3 array, not a length
	if (!cube.origin || !cube.size) {
		return null;
	}
	const stated = vec3(cube.origin);
	const extent = vec3(cube.size);
	/*
	 * A negative size is legal and means the box grows the other way — Ars Nouveau's `empty` is authored
	 * as `origin [8, 16, 8], size [-16, -16, -16]`. Normalised here so a consumer never has to think
	 * about it: a box drawn from a negative size comes out inside out.
	 */
	const origin = stated.map((value, axis) => Math.min(value, value + extent[axis])) as [number, number, number];
	const size = extent.map(value => Math.abs(value)) as [number, number, number];
	const rects = faceRects(cube, size);
	const uv = Array.isArray(cube.uv) ? cube.uv : [];
	return {
		origin: [origin[0] - pivot[0], pivot[1] - origin[1] - size[1], origin[2] - pivot[2]],
		size,
		uv: [uv[0] ?? 0, uv[1] ?? 0],
		inflate: cube.inflate ?? 0,
		mirror: cube.mirror ?? false,
		...(rects && { faces: rects }),
	};
}

/**
 * Converts one parsed `.geo.json` into a model.
 *
 * Bones are a flat list joined by `parent` name, so the tree is rebuilt here. A bone whose parent is
 * missing becomes a root rather than being dropped, and a cube carrying its own rotation becomes a part
 * of its own: `Cube` has nowhere to put a rotation, and 18% of the corpus's cubes have one.
 */
export function geoToModel(geo: ParsedGeo): ExtractedModel {
	const bones = geo.bones as GeoBoneLike[];
	const byName = new Map<string, GeoBoneLike>();
	for (const bone of bones) {
		if (bone.name) {
			byName.set(bone.name, bone);
		}
	}
	const notes: string[] = [];
	const parts = new Map<GeoBoneLike, Part>();
	const pivots = new Map<GeoBoneLike, [number, number, number]>();

	for (const bone of bones) {
		const pivot = vec3(bone.pivot);
		pivots.set(bone, pivot);
		const cubes: Cube[] = [];
		const rotated: Part[] = [];
		for (const cube of bone.cubes ?? []) {
			if (cube.rotation?.some(value => value !== 0) && cube.pivot) {
				const cubePivot = vec3(cube.pivot);
				const converted = toCube(cube, cubePivot);
				if (converted) {
					rotated.push({
						name: `${bone.name ?? 'bone'}_cube${rotated.length + 1}`,
						// The cube's own pivot, relative to the bone it hangs from
						pivot: subtract(toJava(cubePivot), toJava(pivot)),
						rotation: toJavaRotation(cube.rotation),
						cubes: [converted],
						children: [],
					});
				}
				continue;
			}
			const converted = toCube(cube, pivot);
			if (converted) {
				cubes.push(converted);
			}
		}
		parts.set(bone, {
			name: bone.name ?? `bone${parts.size + 1}`,
			pivot: [0, 0, 0],
			rotation: toJavaRotation(bone.rotation),
			cubes,
			children: rotated,
		});
	}

	const roots: Part[] = [];
	for (const bone of bones) {
		const part = parts.get(bone) as Part;
		const parent = bone.parent ? byName.get(bone.parent) : undefined;
		if (parent && parent !== bone && depthOf(bone, byName) < MAX_DEPTH) {
			// A pivot is stated absolutely in bedrock and relative to the parent in a ModelPart
			part.pivot = subtract(toJava(pivots.get(bone) as [number, number, number]), toJava(pivots.get(parent) as [number, number, number]));
			(parts.get(parent) as Part).children.push(part);
			continue;
		}
		if (bone.parent && !parent) {
			notes.push(`${bone.name ?? 'a bone'} names a parent the file does not define, so it hangs from the model root`);
		}
		part.pivot = toJava(pivots.get(bone) as [number, number, number]);
		roots.push(part);
	}

	return {
		textureSize: [geo.textureWidth, geo.textureHeight],
		parts: roots,
		notes,
	};
}

function subtract(left: [number, number, number], right: [number, number, number]): [number, number, number] {
	return [left[0] - right[0], left[1] - right[1], left[2] - right[2]];
}

/** How far a bone sits from its root, which is also the cycle check. */
function depthOf(bone: GeoBoneLike, byName: Map<string, GeoBoneLike>): number {
	const seen = new Set<GeoBoneLike>();
	let current: GeoBoneLike | undefined = bone;
	let depth = 0;
	while (current && !seen.has(current) && depth < MAX_DEPTH) {
		seen.add(current);
		current = current.parent ? byName.get(current.parent) : undefined;
		depth++;
	}
	return depth;
}
