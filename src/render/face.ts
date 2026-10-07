/**
 * Face rendering: cull, transform, project, tint, darken, rasterize — a faithful
 * port of upstream Face::render (docs/renderchest-spec.md §4).
 */

import {
	cloneFloatTexture,
	darkenTexture,
	scaleTextureAlpha,
	tintTexture,
	uvWindow,
} from './blend.ts';
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

import type { FaceShading, FloatTexture } from './blend.ts';
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

/**
 * Pre-shaded textures for one model render, with a byte ceiling.
 *
 * Shading a texel as it is sampled is always correct, but for a small sheet it
 * is slower than shading one copy and reusing it: a block model's faces repeat
 * the same few (window, light level) pairs, and there are far more drawn pixels
 * than texels. The reverse holds for a detailed model on a big sheet — every
 * face is its own key, and the copies are what once reached 20 GB for a single
 * icon. So cache while it is cheap and fall through to per-sample shading once
 * the budget is spent; the two produce identical output.
 */
export interface FaceShadeCache {
	byTexture: WeakMap<FloatTexture, Map<string, FloatTexture>>;
	bytes: number;
}

export function createShadeCache(): FaceShadeCache {
	return { byTexture: new WeakMap(), bytes: 0 };
}

/** Roughly a small sheet reused freely, or one large sheet and no more. */
const MAX_SHADE_CACHE_BYTES = 64 * 1024 * 1024;
const FLOAT_BYTES_PER_TEXEL = 32;

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
	/** Bounded store of pre-shaded textures; omitted means always shade per sample. */
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

	const explicitUvs = geometry.uvs;
	const normalizedBounds = explicitUvs
		? [
			Math.min(...explicitUvs.map(uv => uv[0])),
			Math.min(...explicitUvs.map(uv => uv[1])),
			Math.max(...explicitUvs.map(uv => uv[0])),
			Math.max(...explicitUvs.map(uv => uv[1])),
		]
		: [geometry.uv1[0], geometry.uv1[1], geometry.uv2[0], geometry.uv2[1]];
	const absU1 = normalizedBounds[0] * face.texture.width;
	const absV1 = normalizedBounds[1] * face.texture.height;
	const absU2 = normalizedBounds[2] * face.texture.width;
	const absV2 = normalizedBounds[3] * face.texture.height;
	const tint = geometry.tintIndex !== null ? face.tint : null;
	// Emissive elements stand in for a mod's fullbright render type, where the
	// game ignores the light source entirely.
	const darkness = geometry.emissive ? 0 : 1 - face.light.lightLevelForNormal(shadeDirection);

	// Shading is applied to each sample as the rasterizer writes it, never to a
	// copy of the texture — see FaceShading. The window is the same 1px-expanded
	// box darkenTexture used, because a sample can land just outside the face's
	// UVs and must stay undarkened there.
	const [windowX1, windowY1, windowX2, windowY2] = uvWindow(face.texture, absU1, absV1, absU2, absV2);
	let shading: FaceShading | null = {
		tint,
		darkness,
		alpha: geometry.alpha,
		windowX1,
		windowY1,
		windowX2,
		windowY2,
	};
	let texture = face.texture;
	const shadeKey = `${tint ? `${tint.r},${tint.g},${tint.b}` : '-'}|${darkness}|${geometry.alpha}|${absU1},${absV1},${absU2},${absV2}`;
	const byKey = shadeCache?.byTexture.get(face.texture);
	const cached = byKey?.get(shadeKey);
	const cloneBytes = face.texture.width * face.texture.height * FLOAT_BYTES_PER_TEXEL;
	if (cached) {
		texture = cached;
		shading = null;
	} else if (shadeCache && shadeCache.bytes + cloneBytes <= MAX_SHADE_CACHE_BYTES) {
		const shaded = cloneFloatTexture(face.texture);
		if (tint) {
			tintTexture(shaded, tint.r, tint.g, tint.b);
		}
		darkenTexture(shaded, darkness, absU1, absV1, absU2, absV2);
		if (geometry.alpha < 1) {
			scaleTextureAlpha(shaded, geometry.alpha, absU1, absV1, absU2, absV2);
		}
		const store = byKey ?? new Map<string, FloatTexture>();
		store.set(shadeKey, shaded);
		shadeCache.byTexture.set(face.texture, store);
		shadeCache.bytes += cloneBytes;
		texture = shaded;
		shading = null;
	}

	// UV corners in v0..v3 order; face rotation cycles the assignment.
	const uvs: Array<[number, number]> = explicitUvs?.map(uv => [uv[0], uv[1]]) ?? [
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
	drawTexturedTriangle(point(0), point(2), point(3), buffer, texture, cursor, shading);
	drawTexturedTriangle(point(0), point(1), point(2), buffer, texture, cursor, shading);
	return compactFaceBuffer(buffer);
}
