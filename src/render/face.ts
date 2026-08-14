/**
 * Face rendering: cull, transform, project, tint, darken, rasterize — a faithful
 * port of upstream Face::render (docs/research/renderchest-spec.md §4).
 */

import { cloneFloatTexture, darkenTexture, tintTexture } from './blend.ts';
import {
	RowCursor,
	clearFaceBuffer,
	compactFaceBuffer,
	createFaceBuffer,
	drawTexturedTriangle,
	phpRound,
} from './rasterizer.ts';
import {
	cross,
	dot,
	normalize,
	sub,
	transformDirection,
	transformVector,
} from './vector.ts';

import type { FloatTexture } from './blend.ts';
import type { FaceGeometry } from './geometry.ts';
import type { LightSource } from './lighting.ts';
import type { FaceBuffer } from './rasterizer.ts';
import type { Mat4, Vec3 } from './vector.ts';

export interface TintColor {
	r: number;
	g: number;
	b: number;
}

export interface RenderableFace {
	geometry: FaceGeometry;
	texture: FloatTexture;
	light: LightSource;
	tint: TintColor | null;
	/** Untransformed model-space max Z — upstream's stable pre-sort key. */
	maxZ: number;
}

/** Tinted + darkened textures keyed by source texture, then by shading params. */
export type FaceShadeCache = WeakMap<FloatTexture, Map<string, FloatTexture>>;

export function faceMaxZ(geometry: FaceGeometry): number {
	return Math.max(
		geometry.vertices[0][2],
		geometry.vertices[1][2],
		geometry.vertices[2][2],
		geometry.vertices[3][2],
	);
}

function linearDepth(z: number): number {
	return (z + 1) / 3;
}

function faceNormal(v0: Vec3, v1: Vec3, v2: Vec3): Vec3 | null {
	const normal = cross(sub(v2, v0), sub(v1, v0));
	if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) {
		return null;
	}
	return normalize(normal);
}

/** Returns null when the face is culled, degenerate, or has a zero-area UV. */
export function renderFace(
	face: RenderableFace,
	width: number,
	height: number,
	transformation: Mat4,
	/** Reused across a model's faces; cleared here, compacted before return. */
	scratch?: FaceBuffer,
	/** Shared tint/shade results for one model render. */
	shadeCache?: FaceShadeCache,
): FaceBuffer | null {
	const { geometry } = face;
	const uvWidth = geometry.uv2[0] - geometry.uv1[0];
	const uvHeight = geometry.uv2[1] - geometry.uv1[1];
	if (uvWidth === 0 || uvHeight === 0) {
		return null;
	}

	const [mv0, mv1, mv2, mv3] = geometry.vertices;
	let normal = geometry.shadeDirectionOverride ?? faceNormal(mv0, mv1, mv2);
	if (normal === null) {
		return null;
	}
	normal = normalize(transformDirection(transformation, normal));
	if (dot([0, 0, -1], normal) >= -0.01) {
		return null;
	}

	let shadeDirection = normal;
	if (geometry.shadeDirectionOverride) {
		shadeDirection = normalize(transformDirection(transformation, geometry.shadeDirectionOverride));
	}

	const v0 = transformVector(transformation, mv0);
	const v1 = transformVector(transformation, mv1);
	const v2 = transformVector(transformation, mv2);
	const v3 = transformVector(transformation, mv3);

	const projected = [v0, v1, v2, v3].map((v) => {
		return {
			x: phpRound((v[0] - 0.5) * width + width / 2),
			y: phpRound(height - ((v[1] - 0.5) * height + height / 2)),
		};
	});

	const absU1 = geometry.uv1[0] * face.texture.width;
	const absV1 = geometry.uv1[1] * face.texture.height;
	const absU2 = geometry.uv2[0] * face.texture.width;
	const absV2 = geometry.uv2[1] * face.texture.height;
	const tint = geometry.tintIndex !== null ? face.tint : null;
	const darkness = 1 - face.light.lightLevelForNormal(shadeDirection);

	// Shading depends only on the source texture, the tint, the light level and
	// the UV window, and a block model's elements repeat those combinations
	// constantly (every top face of a fence shares one). Cloning and re-darkening
	// a whole texture per face was pure repeat work.
	const shadeKey = `${tint ? `${tint.r},${tint.g},${tint.b}` : '-'}|${darkness}|${absU1},${absV1},${absU2},${absV2}`;
	let byKey = shadeCache?.get(face.texture);
	let texture = byKey?.get(shadeKey);
	if (!texture) {
		// Clone before tint/darken — the source texture is shared across faces.
		texture = cloneFloatTexture(face.texture);
		if (tint) {
			tintTexture(texture, tint.r, tint.g, tint.b);
		}
		darkenTexture(texture, darkness, absU1, absV1, absU2, absV2);
		if (shadeCache) {
			byKey ??= new Map();
			byKey.set(shadeKey, texture);
			shadeCache.set(face.texture, byKey);
		}
	}

	// UV corners in v0..v3 order; face rotation cycles the assignment.
	const uvs: Array<[number, number]> = [
		[geometry.uv1[0], geometry.uv1[1]],
		[geometry.uv1[0] + uvWidth, geometry.uv1[1]],
		[geometry.uv1[0] + uvWidth, geometry.uv1[1] + uvHeight],
		[geometry.uv1[0], geometry.uv1[1] + uvHeight],
	];
	const rotations = Math.floor(geometry.rotation / 90);
	for (let i = 0; i < rotations; i++) {
		const last = uvs.pop();
		if (last) {
			uvs.unshift(last);
		}
	}

	const buffer = scratch ?? createFaceBuffer(width, height);
	clearFaceBuffer(buffer);
	const depths = [linearDepth(v0[2]), linearDepth(v1[2]), linearDepth(v2[2]), linearDepth(v3[2])];
	const point = (i: number) => {
		return {
			x: projected[i].x,
			y: projected[i].y,
			u: uvs[i][0],
			v: uvs[i][1],
			depth: depths[i],
		};
	};
	// One cursor per face: upstream reuses the same pixel iterators for both
	// triangles, and the row-shift quirk depends on that shared state.
	const cursor = new RowCursor();
	drawTexturedTriangle(point(0), point(2), point(3), buffer, texture, cursor);
	drawTexturedTriangle(point(0), point(1), point(2), buffer, texture, cursor);
	return compactFaceBuffer(buffer);
}
