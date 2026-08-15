/**
 * Element → face geometry, mirroring upstream Element.php: corners from from/to
 * (already /16 into unit-cube space), auto-UVs computed BEFORE element rotation
 * (which mutates the shared corner vectors), quads and UV rects per face direction.
 */

import type { Vec3 } from './vector.ts';
import type { ElementRotationJson, FaceDirectionName, ModelElementJson } from '../models/types.ts';

export interface FaceGeometry {
	direction: FaceDirectionName;
	/** Shared, possibly rotation-mutated corner vectors, in quad order v0..v3. */
	vertices: [Vec3, Vec3, Vec3, Vec3];
	/** Normalized UV rect corners (0–1). */
	uv1: [number, number];
	uv2: [number, number];
	textureRef: string;
	/** Degrees 0/90/180/270 — rotates the UV corner assignment. */
	rotation: number;
	tintIndex: number | null;
	shadeDirectionOverride: Vec3 | null;
	/** Skip directional shading — the element is drawn fullbright. */
	emissive: boolean;
	/** Constant opacity multiplier in [0,1]; 1 leaves the texture untouched. */
	alpha: number;
}

export const FACE_NORMALS: Record<FaceDirectionName, Vec3> = {
	up: [0, 1, 0],
	down: [0, -1, 0],
	north: [0, 0, -1],
	south: [0, 0, 1],
	east: [1, 0, 0],
	west: [-1, 0, 0],
};

export function buildElementFaces(element: ModelElementJson): FaceGeometry[] {
	const from: Vec3 = [element.from[0] / 16, element.from[1] / 16, element.from[2] / 16];
	const to: Vec3 = [element.to[0] / 16, element.to[1] / 16, element.to[2] / 16];

	// Corner naming mirrors upstream: a = max corner, g = min corner.
	const a: Vec3 = [to[0], to[1], to[2]];
	const g: Vec3 = [from[0], from[1], from[2]];
	const b: Vec3 = [g[0], a[1], a[2]];
	const c: Vec3 = [g[0], g[1], a[2]];
	const d: Vec3 = [a[0], g[1], a[2]];
	const e: Vec3 = [a[0], a[1], g[2]];
	const f: Vec3 = [g[0], a[1], g[2]];
	const h: Vec3 = [a[0], g[1], g[2]];

	const quads: Record<FaceDirectionName, [Vec3, Vec3, Vec3, Vec3]> = {
		down: [c, d, h, g],
		up: [f, e, a, b],
		north: [e, f, g, h],
		south: [b, a, d, c],
		west: [f, b, c, g],
		east: [a, e, h, d],
	};

	// Auto-UVs from unrotated corners (upstream computes them before rotation).
	const autoUvs: Record<FaceDirectionName, [[number, number], [number, number]]> = {
		down: [[c[0], c[2]], [h[0], h[2]]],
		up: [[f[0], f[2]], [a[0], a[2]]],
		north: [[g[0], g[1]], [e[0], e[1]]],
		south: [[c[0], c[1]], [a[0], a[1]]],
		west: [[g[2], g[1]], [b[2], b[1]]],
		east: [[h[2], h[1]], [a[2], a[1]]],
	};

	const faces: FaceGeometry[] = [];
	for (const [directionName, faceJson] of Object.entries(element.faces)) {
		const direction = directionName as FaceDirectionName;
		if (!faceJson || !(direction in quads)) {
			continue;
		}
		let uv1: [number, number];
		let uv2: [number, number];
		if (faceJson.uv) {
			uv1 = [faceJson.uv[0] / 16, faceJson.uv[1] / 16];
			uv2 = [faceJson.uv[2] / 16, faceJson.uv[3] / 16];
		} else {
			[uv1, uv2] = autoUvs[direction];
			// Clone: the auto arrays alias corner data conceptually, keep values frozen.
			uv1 = [uv1[0], uv1[1]];
			uv2 = [uv2[0], uv2[1]];
		}
		const override = parseShadeOverride(element);
		faces.push({
			direction,
			vertices: quads[direction],
			uv1,
			uv2,
			textureRef: faceJson.texture,
			rotation: faceJson.rotation ?? 0,
			tintIndex: faceJson.tintindex ?? null,
			shadeDirectionOverride: override,
			emissive: element.emissive_rc === true,
			alpha: clampAlpha(element.alpha_rc),
		});
	}

	// rotation_rc is renderchest's escape hatch, taking precedence over rotation.
	const rotationData = (element as { rotation_rc?: ElementRotationJson; }).rotation_rc ?? element.rotation;
	applyElementRotation(rotationData, [a, b, c, d, e, f, g, h]);
	return faces;
}

function clampAlpha(alpha: number | undefined): number {
	if (typeof alpha !== 'number' || !Number.isFinite(alpha)) {
		return 1;
	}
	return Math.min(1, Math.max(0, alpha));
}

function parseShadeOverride(element: ModelElementJson): Vec3 | null {
	const override = (element as { shade_direction_override?: string; }).shade_direction_override;
	if (override && override in FACE_NORMALS) {
		return FACE_NORMALS[override as FaceDirectionName];
	}
	return null;
}

/**
 * Element rotation mutates the shared corner vectors in place, after face/UV
 * construction. Supports the vanilla {origin, axis, angle} form and the newer
 * per-axis {origin, x?, y?, z?} form (applied X, then Y, then Z). `rotation_rc`
 * takes precedence when present (renderchest escape hatch). No angle restriction,
 * no rescale — matching upstream.
 */
export function applyElementRotation(rotation: ElementRotationJson | undefined, corners: Vec3[]): void {
	if (!rotation) {
		return;
	}
	const origin: Vec3 = [rotation.origin[0] / 16, rotation.origin[1] / 16, rotation.origin[2] / 16];
	const toRadians = Math.PI / 180;
	const multiAxis = rotation as unknown as { x?: number; y?: number; z?: number; };
	if (rotation.axis !== undefined && rotation.angle !== undefined) {
		rotateAll(corners, origin, rotation.axis, rotation.angle * toRadians);
		return;
	}
	for (const axis of ['x', 'y', 'z'] as const) {
		const angle = multiAxis[axis];
		if (typeof angle === 'number' && angle !== 0) {
			rotateAll(corners, origin, axis, angle * toRadians);
		}
	}
}

function rotateAll(corners: Vec3[], origin: Vec3, axis: 'x' | 'y' | 'z', angle: number): void {
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	for (const corner of corners) {
		const x = corner[0] - origin[0];
		const y = corner[1] - origin[1];
		const z = corner[2] - origin[2];
		let rx = x;
		let ry = y;
		let rz = z;
		if (axis === 'x') {
			ry = y * cos - z * sin;
			rz = y * sin + z * cos;
		} else if (axis === 'y') {
			rx = x * cos + z * sin;
			rz = -x * sin + z * cos;
		} else {
			rx = x * cos - y * sin;
			ry = x * sin + y * cos;
		}
		corner[0] = rx + origin[0];
		corner[1] = ry + origin[1];
		corner[2] = rz + origin[2];
	}
}
