/**
 * OBJ geometry as pack data.
 *
 * Forge/NeoForge let a block model point at an `.obj` instead of stating
 * `elements`, and mods use it for everything a box cannot express: Create's
 * crushing wheels and blaze burners, Immersive Engineering's slopes,
 * connectors and split multiblocks, Mekanism's pipes. Across the mod corpus
 * that is 237 block models — the single largest class of geometry the box-only
 * format could not carry.
 *
 * Triangles are a superset of boxes, and a GPU consumer draws them more easily
 * than it draws a cuboid, so the pack gains a `mesh` alongside `elements`
 * rather than trying to approximate the mesh with boxes.
 */

import { materialTexture, parseMtl, parseObj } from '../render/obj.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { ResolvedModel } from '../models/loader.ts';
import type { ResourceManager } from '../resources/manager.ts';

export interface MeshGroup {
	/** Sprite every triangle in this group samples. */
	sprite: string;
	/**
	 * The OBJ `o`/`g` name these triangles came from, omitted when the file
	 * names none. A loader that packs several states of a block into one OBJ
	 * tells them apart by this name, so carrying it lets a consumer filter to
	 * the state it wants instead of drawing every state at once.
	 */
	object?: string;
	/**
	 * xyz per vertex, three vertices per triangle, in the same 0–16 block space
	 * as `elements` (OBJ authors in 0–1, and multiblock meshes exceed it).
	 */
	positions: number[];
	/** uv per vertex, in 0–16 sprite space, matching a face's `uv`. */
	uv: number[];
}

export interface ObjMesh {
	groups: MeshGroup[];
	/** Materials whose texture did not resolve, for the failures sidecar. */
	unresolved: string[];
	triangles: number;
	/** Every object name in the file, before any loader restriction. */
	available: string[];
	/** Whether the loader narrowed the file down to a subset of its objects. */
	restricted: boolean;
	/** The loader picks a subset at runtime and the flattener could not name it. */
	conditional: boolean;
}

export class ObjMeshError extends Error {}

/**
 * A mesh past this is not geometry a chunk renderer wants inlined per block —
 * it is a mod shipping a scenery model. Recorded rather than emitted.
 */
const MAX_TRIANGLES = 20000;

/** OBJ authors blocks in 0–1; the pack speaks 0–16 throughout. */
const BLOCK_UNITS = 16;

/**
 * Joins the two halves of a mesh group's key. An OBJ object name may hold
 * spaces, so the separator is the one character it cannot: object names are
 * line-delimited in the file.
 */
const KEY_SEPARATOR = '\n';

function round(value: number, places: number): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

/**
 * Build the mesh a model's OBJ reference describes, or null when the model has
 * no OBJ. `missingSprite` names the sprite unresolved materials fall back to.
 */
export async function buildObjMesh(
	model: ResolvedModel,
	resources: ResourceManager,
	missingSprite: string,
): Promise<ObjMesh | null> {
	if (!model.obj) {
		return null;
	}
	const objLocator = ResourceLocator.tryParse(model.obj.model);
	if (objLocator === null) {
		throw new ObjMeshError(`unparseable OBJ reference ${model.obj.model}`);
	}
	const source = await resources.getResource('raw', objLocator);
	if (source === null) {
		throw new ObjMeshError(`OBJ file not found: ${model.obj.model}`);
	}
	const parsed = parseObj(source.toString('utf8'), model.obj.flipV);
	const available = [...new Set(parsed.triangles.map(triangle => triangle.object))].filter(Boolean);
	// A loader that packs every state of a block into one OBJ names them per
	// object and picks between them at runtime; `objects` is the subset the
	// flattener settled on for a placed, empty, unpowered block.
	const restricted = Boolean(model.obj.objects);
	if (model.obj.objects) {
		const allowed = new Set(model.obj.objects);
		parsed.triangles = parsed.triangles.filter(triangle => allowed.has(triangle.object));
	}
	if (parsed.triangles.length === 0) {
		throw new ObjMeshError(`OBJ has no faces: ${model.obj.model}`);
	}
	if (parsed.triangles.length > MAX_TRIANGLES) {
		throw new ObjMeshError(`OBJ has ${parsed.triangles.length} triangles, over the ${MAX_TRIANGLES} cap`);
	}

	const materials = new Map<string, string>();
	const directory = objLocator.path.split('/').slice(0, -1).join('/');
	for (const library of parsed.materialLibs) {
		const libraryPath = library.includes('/') ? library : `${directory}/${library}`;
		const libraryLocator = ResourceLocator.tryParse(`${objLocator.namespace}:${libraryPath}`);
		const raw = libraryLocator ? await resources.getResource('raw', libraryLocator) : null;
		if (raw === null) {
			continue;
		}
		for (const [name, texture] of parseMtl(raw.toString('utf8'))) {
			materials.set(name, texture);
		}
	}

	const groups = new Map<string, MeshGroup>();
	const unresolved = new Set<string>();
	for (const triangle of parsed.triangles) {
		const locator = materialTexture(model, materials, triangle.material);
		if (locator === null) {
			unresolved.add(triangle.material);
		}
		const sprite = locator === null ? missingSprite : locator.toString();
		// Grouped by object as well as sprite: a consumer filtering to one state
		// of a multi-state OBJ needs the boundary preserved.
		const key = `${triangle.object}${KEY_SEPARATOR}${sprite}`;
		let group = groups.get(key);
		if (!group) {
			group = { sprite, ...(triangle.object && { object: triangle.object }), positions: [], uv: [] };
			groups.set(key, group);
		}
		for (let corner = 0; corner < 3; corner++) {
			const position = triangle.positions[corner];
			group.positions.push(
				round(position[0] * BLOCK_UNITS, 3),
				round(position[1] * BLOCK_UNITS, 3),
				round(position[2] * BLOCK_UNITS, 3),
			);
			group.uv.push(round(triangle.uvs[corner][0] * BLOCK_UNITS, 4), round(triangle.uvs[corner][1] * BLOCK_UNITS, 4));
		}
	}
	return {
		groups: groups.values().toArray().toSorted((left, right) => (left.object ?? '').localeCompare(right.object ?? '') || left.sprite.localeCompare(right.sprite)),
		unresolved: [...unresolved],
		triangles: parsed.triangles.length,
		available,
		restricted,
		conditional: model.obj.conditional === true,
	};
}
