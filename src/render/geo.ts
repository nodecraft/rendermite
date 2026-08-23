/**
 * Bedrock-format geometry (`.geo.json`) rendering, best-effort. GeckoLib mods
 * ship their item/entity geometry in this format and register the renderer in
 * Java code — the old pipeline extracted these files and never read them, so
 * every GeckoLib item was a guaranteed miss. Cubes + bone hierarchy convert
 * into the same face geometry the JSON-element pipeline rasterizes; the model
 * is auto-fitted into the unit cube and given the standard block gui pose.
 */

import { toFloatTexture } from './blend.ts';
import { combineFaceBuffers } from './compose.ts';
import { createShadeCache, faceMaxZ, renderFace } from './face.ts';
import { lightsForProfile } from './lighting.ts';
import { createFaceBuffer } from './rasterizer.ts';
import { displayMatrix } from './vector.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { FloatTexture } from './blend.ts';
import type { RenderableFace } from './face.ts';
import type { FaceGeometry } from './geometry.ts';
import type { RenderOptions } from './renderer.ts';
import type { Vec3 } from './vector.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { TextureLoader } from '../textures/loader.ts';

interface GeoCube {
	origin?: number[];
	size?: number[];
	uv?: number[] | Record<string, { uv: number[]; uv_size?: number[]; }>;
	inflate?: number;
	/** Bedrock mirrors a box's texture rather than its geometry, so only a consumer's UVs care. */
	mirror?: boolean;
	pivot?: number[];
	rotation?: number[];
}

interface GeoBone {
	name?: string;
	parent?: string;
	pivot?: number[];
	rotation?: number[];
	cubes?: GeoCube[];
}

interface GeoDescription {
	texture_width?: number;
	texture_height?: number;
}

interface GeoFile {
	'minecraft:geometry'?: Array<{ description?: GeoDescription; bones?: GeoBone[]; }>;
	[key: string]: unknown;
}

export interface ParsedGeo {
	textureWidth: number;
	textureHeight: number;
	bones: GeoBone[];
}

/** Handles both the modern (1.12+) and legacy (`geometry.name` keyed) layouts. */
export function parseGeo(json: GeoFile): ParsedGeo | null {
	const modern = json['minecraft:geometry']?.[0];
	if (modern?.bones) {
		return {
			textureWidth: modern.description?.texture_width ?? 64,
			textureHeight: modern.description?.texture_height ?? 64,
			bones: modern.bones,
		};
	}
	for (const [key, value] of Object.entries(json)) {
		if (!(key.startsWith('geometry.') && value && typeof value === 'object')) {
			continue;
		}

		const legacy = value as { texturewidth?: number; textureheight?: number; bones?: GeoBone[]; };
		if (legacy.bones) {
			return {
				textureWidth: legacy.texturewidth ?? 64,
				textureHeight: legacy.textureheight ?? 64,
				bones: legacy.bones,
			};
		}
	}
	return null;
}

function rotatePoint(point: Vec3, pivot: Vec3, rotation: Vec3): Vec3 {
	// Bedrock rotations are degrees, applied z, then y, then x, with x and y
	// negated relative to our right-handed convention.
	const toRadians = Math.PI / 180;
	let [x, y, z] = [point[0] - pivot[0], point[1] - pivot[1], point[2] - pivot[2]];
	const [rx, ry, rz] = [-rotation[0] * toRadians, -rotation[1] * toRadians, rotation[2] * toRadians];
	// Z
	[x, y] = [x * Math.cos(rz) - y * Math.sin(rz), x * Math.sin(rz) + y * Math.cos(rz)];
	// Y
	[x, z] = [x * Math.cos(ry) + z * Math.sin(ry), -x * Math.sin(ry) + z * Math.cos(ry)];
	// X
	[y, z] = [y * Math.cos(rx) - z * Math.sin(rx), y * Math.sin(rx) + z * Math.cos(rx)];
	return [x + pivot[0], y + pivot[1], z + pivot[2]];
}

interface BoxFaceSpec {
	direction: FaceGeometry['direction'];
	corners: [Vec3, Vec3, Vec3, Vec3];
	uv: [number, number, number, number];
}

/** Standard Minecraft box unwrap for `uv: [u, v]` cubes. */
function boxFaces(origin: Vec3, size: Vec3, u: number, v: number): BoxFaceSpec[] {
	const [ox, oy, oz] = origin;
	const [sx, sy, sz] = size;
	const x1 = ox + sx;
	const y1 = oy + sy;
	const z1 = oz + sz;
	const corner = (x: number, y: number, z: number): Vec3 => [x, y, z];
	// Quad corner order mirrors geometry.ts: v0..v3 map to uv rect corners.
	return [
		{ direction: 'up', corners: [corner(ox, y1, oz), corner(x1, y1, oz), corner(x1, y1, z1), corner(ox, y1, z1)], uv: [u + sz, v, u + sz + sx, v + sz] },
		{ direction: 'down', corners: [corner(ox, oy, z1), corner(x1, oy, z1), corner(x1, oy, oz), corner(ox, oy, oz)], uv: [u + sz + sx, v, u + sz + sx + sx, v + sz] },
		{ direction: 'north', corners: [corner(x1, y1, oz), corner(ox, y1, oz), corner(ox, oy, oz), corner(x1, oy, oz)], uv: [u + sz, v + sz, u + sz + sx, v + sz + sy] },
		{ direction: 'south', corners: [corner(ox, y1, z1), corner(x1, y1, z1), corner(x1, oy, z1), corner(ox, oy, z1)], uv: [u + sz + sx + sz, v + sz, u + sz + sx + sz + sx, v + sz + sy] },
		{ direction: 'east', corners: [corner(x1, y1, z1), corner(x1, y1, oz), corner(x1, oy, oz), corner(x1, oy, z1)], uv: [u, v + sz, u + sz, v + sz + sy] },
		{ direction: 'west', corners: [corner(ox, y1, oz), corner(ox, y1, z1), corner(ox, oy, z1), corner(ox, oy, oz)], uv: [u + sz + sx, v + sz, u + sz + sx + sz, v + sz + sy] },
	];
}

/** Convert a parsed geo into face geometry, unit-cube fitted with gui pose. */
export function geoToFaces(geo: ParsedGeo, options: { fit?: boolean; } = {}): FaceGeometry[] {
	const bonesByName = new Map<string, GeoBone>();
	for (const bone of geo.bones) {
		if (bone.name) {
			bonesByName.set(bone.name, bone);
		}
	}
	const boneChain = (bone: GeoBone): GeoBone[] => {
		const chain: GeoBone[] = [];
		let current: GeoBone | undefined = bone;
		while (current) {
			chain.push(current);
			current = current.parent ? bonesByName.get(current.parent) : undefined;
			if (chain.length > 32) {
				break;
			}
		}
		return chain;
	};

	const faces: FaceGeometry[] = [];
	const min: Vec3 = [Infinity, Infinity, Infinity];
	const max: Vec3 = [-Infinity, -Infinity, -Infinity];

	for (const bone of geo.bones) {
		const chain = boneChain(bone);
		for (const cube of bone.cubes ?? []) {
			// eslint-disable-next-line unicorn/explicit-length-check -- cube.size is a Vec3 array, not a length
			if (!cube.origin || !cube.size) {
				continue;
			}
			const inflate = cube.inflate ?? 0;
			const origin: Vec3 = [cube.origin[0] - inflate, cube.origin[1] - inflate, cube.origin[2] - inflate];
			const size: Vec3 = [cube.size[0] + inflate * 2, cube.size[1] + inflate * 2, cube.size[2] + inflate * 2];
			const uvBase = Array.isArray(cube.uv) ? cube.uv : null;
			const perFace = !Array.isArray(cube.uv) && cube.uv ? cube.uv : null;

			for (const spec of boxFaces(origin, size, uvBase?.[0] ?? 0, uvBase?.[1] ?? 0)) {
				let uvRect = spec.uv;
				if (perFace) {
					const entry = perFace[spec.direction];
					if (!entry) {
						continue;
					}
					const uvSize = entry.uv_size ?? [size[0], size[1]];
					uvRect = [entry.uv[0], entry.uv[1], entry.uv[0] + uvSize[0], entry.uv[1] + uvSize[1]];
				}
				// Apply cube rotation, then the bone chain leaf-to-root.
				let corners = spec.corners.map(point => [...point] as Vec3);
				if (cube.rotation && cube.pivot) {
					corners = corners.map(point => rotatePoint(point, cube.pivot as Vec3, cube.rotation as Vec3));
				}
				for (const link of chain) {
					if (link.rotation && link.pivot) {
						corners = corners.map(point => rotatePoint(point, link.pivot as Vec3, link.rotation as Vec3));
					}
				}
				// Mirror X: Bedrock's +x is Java's -x. Negating one axis reverses the
				// quad's winding, which flips the normal renderFace culls on — left
				// alone, every geo model rendered inside-out, showing the far faces
				// (a cube drew its bottom from a top-down view). Reversing the corner
				// order restores the winding, and because renderFace pairs UV corners
				// to vertices by index it mirrors the face's texture to match the
				// mirrored geometry.
				corners = corners.map(point => [-point[0], point[1], point[2]] as Vec3);
				corners = [corners[0], corners[3], corners[2], corners[1]];
				for (const point of corners) {
					for (let axis = 0; axis < 3; axis++) {
						min[axis] = Math.min(min[axis], point[axis]);
						max[axis] = Math.max(max[axis], point[axis]);
					}
				}
				faces.push({
					direction: spec.direction,
					vertices: corners as [Vec3, Vec3, Vec3, Vec3],
					uv1: [uvRect[0] / geo.textureWidth, uvRect[1] / geo.textureHeight],
					uv2: [uvRect[2] / geo.textureWidth, uvRect[3] / geo.textureHeight],
					textureRef: '#geo',
					rotation: 0,
					tintIndex: null,
					shadeDirectionOverride: null,
					emissive: false,
					alpha: 1,
				});
			}
		}
	}

	// Entity and item callers need a unit-cube preview. A block-entity renderer does not: its Bedrock
	// coordinates are already pixels relative to the block centre, and geometry outside +/-8 is the
	// formed machine extending into neighbouring blocks. Keep those coordinates intact for that path.
	const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
	if (!Number.isFinite(extent) || extent <= 0) {
		return [];
	}
	if (options.fit === false) {
		return faces;
	}
	const scale = 1 / extent;
	const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
	for (const face of faces) {
		for (const vertex of face.vertices) {
			for (let axis = 0; axis < 3; axis++) {
				vertex[axis] = (vertex[axis] - center[axis]) * scale + 0.5;
			}
		}
	}
	return faces;
}

/** Conventional locations GeckoLib mods keep item geometry and textures. */
export async function findGeoForItem(
	resources: ResourceManager,
	id: string,
): Promise<{ geo: ParsedGeo; texture: ResourceLocator; } | null> {
	const locator = ResourceLocator.parse(id);
	const geoPaths = [
		`geo/${locator.path}.geo.json`,
		`geo/item/${locator.path}.geo.json`,
		`geckolib/geo/${locator.path}.geo.json`,
		`models/geo/${locator.path}.geo.json`,
	];
	// Mods nest geo under their own subtrees (oritech's geo/block/models/) —
	// scan for any <name>.geo.json under a geo directory when the conventional
	// spots miss. Shortest path wins so a top-level file beats variants.
	const geoPathHits = await Promise.all(geoPaths.map(path => resources.hasResource('raw', new ResourceLocator(locator.namespace, path))));
	const name = locator.path.split('/').pop() ?? locator.path;
	if (!geoPathHits.includes(true)) {
		const candidates = await resources.listResources('raw', locator.namespace);
		const geoFiles = candidates
			.map(candidate => candidate.path)
			.filter(path => path.endsWith('.geo.json') && /(?:^|\/)(?:geo|geckolib)\//.test(path));
		const matches = geoFiles
			.filter(path => path.endsWith(`/${name}.geo.json`))
			.toSorted((left, right) => left.length - right.length);
		geoPaths.push(...matches);
		// Mods ship one geo per base shape and register the variants in code:
		// pokeblocks draws gigantic_pokedoll_absol and pokedoll_shiny_absol from
		// pokedoll_absol.geo.json, and eiscue_head_pile from eiscue_head_pile_1.
		// Accept a geo whose every token appears in the item name — a subset test,
		// so an unrelated model can never match the way a similarity score would —
		// and prefer the most specific.
		if (matches.length === 0) {
			const wanted = new Set(nameTokens(name));
			const scored = geoFiles
				.map((path) => {
					const tokens = nameTokens(path.split('/').pop()?.replace(/\.geo\.json$/, '') ?? '');
					return { path, tokens };
				})
				.filter(entry => entry.tokens.length > 0 && entry.tokens.every(token => wanted.has(token)))
				.toSorted((left, right) => right.tokens.length - left.tokens.length || left.path.length - right.path.length);
			geoPaths.push(...scored.map(entry => entry.path));
		}
	}
	for (const geoPath of geoPaths) {
		const raw = await resources.getResource('raw', new ResourceLocator(locator.namespace, geoPath));
		if (!raw) {
			continue;
		}
		let geo: ParsedGeo | null;
		try {
			geo = parseGeo(JSON.parse(raw.toString('utf8')) as GeoFile);
		} catch {
			continue;
		}
		if (!geo) {
			continue;
		}
		// The texture usually mirrors the geo path with the geo/ prefix dropped
		// (geo/block/models/x.geo.json ↔ textures/block/models/x.png).
		const mirrored = geoPath.replace(/(^|\/)(geo|geckolib\/geo|models\/geo)\//, '$1').replace(/^\//, '').replace(/\.geo\.json$/, '');
		for (const texturePath of [mirrored, `item/${locator.path}`, `items/${locator.path}`, `geo/${locator.path}`]) {
			const texture = new ResourceLocator(locator.namespace, texturePath);
			if (await resources.hasResource('texture', texture)) {
				return { geo, texture };
			}
		}
		// Mods just as often file the skin by name under a directory of their own
		// choosing (ars_nouveau keeps geo/<name>.geo.json beside
		// textures/block/<name>.png), so fall back to matching the leaf name.
		// The ITEM's name is tried before the geo's: a variant sharing a base
		// shape still has its own skin, and pokedoll_shiny_absol wearing
		// pokedoll_absol's would be the right doll in the wrong colours.
		const geoName = geoPath.split('/').pop()?.replace(/\.geo\.json$/, '') ?? '';
		const named = await findTextureByName(resources, locator.namespace, name)
			?? await findVariantTexture(resources, locator.namespace, name)
			?? await findTextureByName(resources, locator.namespace, geoName);
		if (named) {
			return { geo, texture: named };
		}
	}
	return null;
}

/** Name tokens, dropping the numeric suffixes mods use for shape variants. */
/** Tokens of a name, for the matches that need to see through a mod's own spelling of it. */
export function nameTokens(name: string): string[] {
	return name.split(/[/_]/).filter(token => token.length > 0 && !/^\d+$/.test(token));
}

/**
 * A skin whose name carries every token of the item's, in any order and with
 * decoration allowed. pokeblocks writes `pokedoll_shiny_absol` as
 * `pokedoll_absol_shiny_texture.png`, so neither an exact nor a suffix match
 * finds it. Requiring the item's tokens to all be present keeps this from
 * wandering onto a sibling variant's skin.
 */
async function findVariantTexture(
	resources: ResourceManager,
	namespace: string,
	itemName: string,
): Promise<ResourceLocator | null> {
	const wanted = nameTokens(itemName);
	if (wanted.length === 0) {
		return null;
	}
	let best: ResourceLocator | null = null;
	let bestExtra = Infinity;
	for (const locator of await resources.listResources('texture', namespace)) {
		const tokens = nameTokens(locator.path.split('/').pop() ?? '').filter(token => token !== 'texture');
		if (!wanted.every(token => tokens.includes(token))) {
			continue;
		}
		// Fewest unrelated tokens wins, so the plain skin beats an overlay.
		const extra = tokens.length - wanted.length;
		if (extra < bestExtra || (extra === bestExtra && best !== null && locator.path.length < best.path.length)) {
			best = locator;
			bestExtra = extra;
		}
	}
	return best;
}

/**
 * The shortest-path texture named after `name`. GeckoLib binds the skin in Java
 * rather than in the geo file, so the only link is the shared name — and a mod
 * may decorate it (pokeblocks files 344 figurines as `<name>_texture.png`).
 * An exact match always wins over a decorated one.
 */
async function findTextureByName(
	resources: ResourceManager,
	namespace: string,
	name: string,
): Promise<ResourceLocator | null> {
	if (name === '') {
		return null;
	}
	let best: ResourceLocator | null = null;
	let bestExact = false;
	for (const locator of await resources.listResources('texture', namespace)) {
		const leaf = locator.path.split('/').pop() ?? '';
		const exact = leaf === name;
		if (!exact && leaf !== `${name}_texture`) {
			continue;
		}
		if (best === null || (exact && !bestExact) || (exact === bestExact && locator.path.length < best.path.length)) {
			best = locator;
			bestExact = exact;
		}
	}
	return best;
}

/** Render a parsed geo with the standard block gui pose. */
export async function renderGeo(
	geo: ParsedGeo,
	texture: ResourceLocator,
	textures: TextureLoader,
	options: RenderOptions,
): Promise<FloatTexture | null> {
	const faces = geoToFaces(geo);
	if (faces.length === 0) {
		return null;
	}
	const loaded = await textures.load(texture);
	if (!loaded) {
		return null;
	}
	const float = toFloatTexture(loaded);
	const lights = lightsForProfile(options.lightingProfile);
	const renderSize = options.size * options.quality;
	const transformation = displayMatrix([30, 225, 0], [0, 0, 0], [0.625, 0.625, 0.625]);

	const renderable: RenderableFace[] = faces.map((geometry) => {
		return {
			geometry,
			texture: float,
			light: lights.side,
			tint: null,
			maxZ: faceMaxZ(geometry),
		};
	});
	renderable.sort((a, b) => a.maxZ - b.maxZ);

	const buffers = [];
	const scratch = createFaceBuffer(renderSize, renderSize);
	const shadeCache = createShadeCache();
	for (const face of renderable) {
		const buffer = renderFace(face, renderSize, renderSize, transformation, scratch, shadeCache);
		if (buffer) {
			buffers.push(buffer);
		}
	}
	if (buffers.length === 0) {
		return null;
	}
	return combineFaceBuffers(renderSize, renderSize, buffers);
}
