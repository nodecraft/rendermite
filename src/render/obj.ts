/**
 * Forge/NeoForge OBJ model rendering — the class the old pipeline left
 * permanently broken ("the geometry is in a different file format"). Parses
 * OBJ + MTL out of the asset tree and rasterizes the triangles through the
 * same projection/lighting as JSON elements, with a z-tested shared buffer
 * (per-triangle painter buffers would be quadratic in triangle count).
 */

import { cloneFloatTexture, darkenTexture, toFloatTexture } from './blend.ts';
import { blendPixel } from './blend.ts';
import { lightsForProfile } from './lighting.ts';
import {
	RowCursor,
	clearFaceBuffer,
	createFaceBuffer,
	drawTexturedTriangle,
	phpRound,
} from './rasterizer.ts';
import { ItemRenderError } from './renderer.ts';
import {
	cross,
	displayMatrix,
	dot,
	identity,
	multiply,
	normalize,
	sub,
	transformVector,
} from './vector.ts';
import { resolveTexture } from '../models/loader.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { FaceShading, FloatTexture } from './blend.ts';
import type { RenderOptions } from './renderer.ts';
import type { Vec3 } from './vector.ts';
import type { ResolvedModel } from '../models/loader.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { TextureLoader } from '../textures/loader.ts';

/** RGBA float channels, 8 bytes each. */
const FLOAT_BYTES_PER_TEXEL = 32;

/** Clone budget for one OBJ render; past it samples are shaded individually. */
const MAX_OBJ_SHADE_BYTES = 64 * 1024 * 1024;

interface ObjTriangle {
	positions: [Vec3, Vec3, Vec3];
	uvs: [[number, number], [number, number], [number, number]];
	material: string;
	/** The `o`/`g` name in effect, so a loader can draw one state of many. */
	object: string;
}

interface ParsedObj {
	triangles: ObjTriangle[];
	/** MTL library paths referenced via mtllib, relative to the OBJ's directory. */
	materialLibs: string[];
}

/** Parse OBJ text into triangles (polygon faces are fan-triangulated). */
export function parseObj(text: string, flipV: boolean): ParsedObj {
	const positions: Vec3[] = [];
	const uvs: Array<[number, number]> = [];
	const triangles: ObjTriangle[] = [];
	const materialLibs: string[] = [];
	let material = '';
	let object = '';

	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#')) {
			continue;
		}
		const parts = line.split(/\s+/);
		switch (parts[0]) {
			case 'v': {
				positions.push([Number(parts[1]), Number(parts[2]), Number(parts[3])]);
				break;
			}
			case 'vt': {
				const u = Number(parts[1]);
				const v = Number(parts[2] ?? 0);
				uvs.push([u, flipV ? 1 - v : v]);
				break;
			}
			case 'usemtl': {
				material = parts.slice(1).join(' ');
				break;
			}
			case 'o':
			case 'g': {
				object = parts.slice(1).join(' ');
				break;
			}
			case 'mtllib': {
				materialLibs.push(parts.slice(1).join(' '));
				break;
			}
			case 'f': {
				const corners = parts.slice(1).map((corner) => {
					const [vIndex, vtIndex] = corner.split('/', 2);
					// OBJ indices are 1-based; negatives count from the end. Broken
					// indices fall back to (0,0) rather than crashing the item.
					const position = Number(vIndex);
					const uvIndex = vtIndex === undefined || vtIndex === '' ? 0 : Number(vtIndex);
					const uv = uvIndex === 0 ? undefined : uvs[uvIndex > 0 ? uvIndex - 1 : uvs.length + uvIndex];
					return {
						position: positions[position > 0 ? position - 1 : positions.length + position],
						uv: uv ?? [0, 0] as [number, number],
					};
				});
				for (let i = 2; i < corners.length; i++) {
					if (!corners[0]?.position || !corners[i - 1]?.position || !corners[i]?.position) {
						continue;
					}
					triangles.push({
						positions: [corners[0].position, corners[i - 1].position, corners[i].position],
						uvs: [corners[0].uv, corners[i - 1].uv, corners[i].uv],
						material,
						object,
					});
				}
				break;
			}
			default:
		}
	}
	return { triangles, materialLibs };
}

/** map_Kd texture per material name out of an MTL library. */
export function parseMtl(text: string): Map<string, string> {
	const materials = new Map<string, string>();
	let current = '';
	for (const rawLine of text.split('\n')) {
		const line = rawLine.trim();
		const parts = line.split(/\s+/);
		if (parts[0] === 'newmtl') {
			current = parts.slice(1).join(' ');
		} else if (parts[0] === 'map_Kd' && current) {
			materials.set(current, parts.slice(1).join(' '));
		}
	}
	return materials;
}

/**
 * Resolve a material name to a texture locator: `#key` and MTL map_Kd values
 * go through the model's texture map (Forge binds materials that way); bare
 * names fall back to a direct locator.
 */
function materialTexture(model: ResolvedModel, materials: Map<string, string>, material: string): ResourceLocator | null {
	const mapped = materials.get(material) ?? material;
	if (mapped.startsWith('#')) {
		return resolveTexture(model, mapped);
	}
	const viaMap = resolveTexture(model, `#${mapped}`);
	if (viaMap) {
		return viaMap;
	}
	return ResourceLocator.tryParse(mapped);
}

export async function renderObjModel(
	model: ResolvedModel,
	resources: ResourceManager,
	textures: TextureLoader,
	options: RenderOptions,
): Promise<FloatTexture> {
	if (!model.obj) {
		throw new ItemRenderError(`renderObjModel called without obj geometry: ${model.locator}`);
	}
	const objLocator = ResourceLocator.parse(model.obj.model);
	const objSource = await resources.getResource('raw', objLocator);
	if (!objSource) {
		throw new ItemRenderError(`OBJ file not found: ${model.obj.model} for ${model.locator}`);
	}
	const parsed = parseObj(objSource.toString('utf8'), model.obj.flipV);
	// A loader that packs every state of a connectable block into one OBJ names
	// them per object; `objects` keeps only the state an item should show.
	const wanted = model.obj.objects;
	if (wanted) {
		const allowed = new Set(wanted);
		parsed.triangles = parsed.triangles.filter(triangle => allowed.has(triangle.object));
	}
	if (parsed.triangles.length === 0) {
		throw new ItemRenderError(`OBJ has no faces: ${model.obj.model}`);
	}

	const materials = new Map<string, string>();
	const objDirectory = objLocator.path.split('/').slice(0, -1).join('/');
	for (const lib of parsed.materialLibs) {
		const libPath = lib.includes('/') ? lib : `${objDirectory}/${lib}`;
		const libLocator = ResourceLocator.tryParse(`${objLocator.namespace}:${libPath}`);
		const source = libLocator ? await resources.getResource('raw', libLocator) : null;
		if (source) {
			for (const [name, texture] of parseMtl(source.toString('utf8'))) {
				materials.set(name, texture);
			}
		}
	}

	const lights = lightsForProfile(options.lightingProfile);
	const light = model.elementsGuiLight === 'side' ? lights.side : lights.front;
	const gui = model.display.gui;
	const guiMatrix = displayMatrix(
		(gui?.rotation ?? [0, 0, 0]) as Vec3,
		(gui?.translation ?? [0, 0, 0]) as Vec3,
		(gui?.scale ?? [1, 1, 1]) as Vec3,
	);
	const transformation = multiply(guiMatrix, options.itemTransform ?? identity());

	const renderSize = options.size * options.quality;
	const out = createFaceBuffer(renderSize, renderSize);
	const scratch = createFaceBuffer(renderSize, renderSize);
	// Darkened texture variants per material+light bucket, so shading matches
	// the JSON-element pipeline without re-darkening per triangle. Bounded by
	// bytes: a mesh with varied normals fills all 65 light buckets, and against a
	// large sheet that is gigabytes of clones for one icon (bloodandmadness'
	// 1,493-triangle burial_blade reached 1.3 GB). Past the budget each sample is
	// shaded as it is written instead, which is the same arithmetic.
	const shaded = new Map<string, FloatTexture>();
	let shadedBytes = 0;

	for (const triangle of parsed.triangles) {
		const transformed = triangle.positions.map(position => transformVector(transformation, position)) as [Vec3, Vec3, Vec3];
		const rawNormal = cross(sub(transformed[1], transformed[0]), sub(transformed[2], transformed[0]));
		if (rawNormal[0] === 0 && rawNormal[1] === 0 && rawNormal[2] === 0) {
			continue;
		}
		const normal = normalize(rawNormal);
		if (dot([0, 0, -1], normal) >= -0.01) {
			continue;
		}
		const level = light.lightLevelForNormal(normal);
		const bucket = Math.round(level * 64);
		// Derived once and shared by both shading branches below. Writing it twice
		// invites them to drift, and a drift would be invisible: each branch renders
		// correctly on its own, just differently from the other.
		const darkness = 1 - bucket / 64;

		const locator = materialTexture(model, materials, triangle.material);
		if (!locator) {
			throw new ItemRenderError(`Unresolvable OBJ material ${triangle.material} in ${model.locator}`);
		}
		const key = `${locator} ${bucket}`;
		let texture = shaded.get(key);
		let shading: FaceShading | null = null;
		if (!texture) {
			// IE's IEOBJ materials reference sheets relative to textures/item/
			// (revolvers/revolver) — retry there before giving up.
			const base = await textures.load(locator)
				?? await textures.load(new ResourceLocator(locator.namespace, `item/${locator.path}`));
			if (!base) {
				throw new ItemRenderError(`Missing texture ${locator} referenced by ${model.obj.model}`);
			}
			const float = toFloatTexture(base);
			const bytes = float.width * float.height * FLOAT_BYTES_PER_TEXEL;
			if (shadedBytes + bytes <= MAX_OBJ_SHADE_BYTES) {
				texture = cloneFloatTexture(float);
				darkenTexture(texture, darkness, 0, 0, texture.width, texture.height);
				shaded.set(key, texture);
				shadedBytes += bytes;
			} else {
				texture = float;
				shading = {
					tint: null,
					darkness,
					alpha: 1,
					windowX1: 0,
					windowY1: 0,
					windowX2: float.width - 1,
					windowY2: float.height - 1,
				};
			}
		}

		// Rasterize into a reused scratch buffer, then z-merge into the shared one:
		// larger depth = nearer the viewer.
		clearFaceBuffer(scratch);
		const cursor = new RowCursor();
		const point = (index: number) => {
			return {
				x: phpRound((transformed[index][0] - 0.5) * renderSize + renderSize / 2),
				y: phpRound(renderSize - ((transformed[index][1] - 0.5) * renderSize + renderSize / 2)),
				u: triangle.uvs[index][0],
				v: triangle.uvs[index][1],
				depth: (transformed[index][2] + 1) / 3,
			};
		};
		drawTexturedTriangle(point(0), point(1), point(2), scratch, texture, cursor, shading);
		// Only the triangle's own span can differ from the shared buffer.
		for (let y = Math.max(scratch.dirty.minY, 0); y <= Math.min(scratch.dirty.maxY, renderSize - 1); y++) {
			for (let x = Math.max(scratch.dirty.minX, 0); x <= Math.min(scratch.dirty.maxX, renderSize - 1); x++) {
				const pixel = y * renderSize + x;
				const offset = pixel * 4;
				const alpha = scratch.colors[offset + 3];
				if (alpha <= 0) {
					continue;
				}
				if (scratch.depths[pixel] >= out.depths[pixel] || out.colors[offset + 3] === 0) {
					if (alpha >= 1 || out.colors[offset + 3] === 0) {
						out.colors[offset] = scratch.colors[offset];
						out.colors[offset + 1] = scratch.colors[offset + 1];
						out.colors[offset + 2] = scratch.colors[offset + 2];
						out.colors[offset + 3] = alpha;
					} else {
						blendPixel(out.colors, offset, scratch.colors[offset], scratch.colors[offset + 1], scratch.colors[offset + 2], alpha);
					}
					out.depths[pixel] = Math.max(out.depths[pixel], scratch.depths[pixel]);
				}
			}
		}
	}

	return { width: renderSize, height: renderSize, data: out.colors };
}
