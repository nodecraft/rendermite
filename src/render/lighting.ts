import {
	dot,
	multiply,
	normalize,
	rotationEuler,
	rotationX,
	rotationY,
	scaling,
	transformDirection,
} from './vector.ts';

import type { Vec3 } from './vector.ts';

export interface LightSource {
	/** Light level in [0,1] for a view-space normal; faces darken by 1 - level. */
	lightLevelForNormal(normal: Vec3): number;
}

/** Vanilla two-direction diffuse (renderchest master, v5.2.0-beta.3+). */
export class DiffuseLightSource implements LightSource {
	private readonly direction0: Vec3;
	private readonly direction1: Vec3;

	constructor(direction0: Vec3, direction1: Vec3, transformation: Float64Array) {
		this.direction0 = transformDirection(transformation, normalize(direction0));
		this.direction1 = transformDirection(transformation, normalize(direction1));
	}

	lightLevelForNormal(normal: Vec3): number {
		return Math.min(1, (Math.max(0, dot(this.direction0, normal)) + Math.max(0, dot(this.direction1, normal))) * 0.6 + 0.4);
	}
}

const BASE_DIRECTION_0: Vec3 = [0.2, 1, -0.7];
const BASE_DIRECTION_1: Vec3 = [-0.2, 1, 0.7];

export function guiFrontLight(): LightSource {
	const transform = multiply(multiply(scaling(1, -1, 1), rotationY(-Math.PI / 8)), rotationX(Math.PI * 3 / 4));
	return new DiffuseLightSource(BASE_DIRECTION_0, BASE_DIRECTION_1, transform);
}

export function guiSideLight(): LightSource {
	const transform = multiply(
		rotationEuler(3.2375858, 1.0821041, 0),
		rotationEuler(Math.PI * 3 / 4, -Math.PI / 8, 0),
	);
	return new DiffuseLightSource(BASE_DIRECTION_0, BASE_DIRECTION_1, transform);
}

/**
 * Legacy single-direction light used by the tags the published corpus was rendered
 * with (v2.5.2 through v5.1.0): darkness = max(0, (dot(n, dir) + 1)/2 - baseLight),
 * front light entirely inactive. Kept for golden-image comparison, not default output.
 */
export class LegacyLightSource implements LightSource {
	private readonly direction: Vec3;
	private readonly baseLight: number;
	private readonly active: boolean;

	constructor(direction: Vec3, baseLight: number, active: boolean) {
		this.direction = normalize(direction);
		this.baseLight = baseLight;
		this.active = active;
	}

	lightLevelForNormal(normal: Vec3): number {
		if (!this.active) {
			return 1;
		}
		return 1 - Math.max(0, (dot(normal, this.direction) + 1) / 2 - this.baseLight);
	}
}

export function legacySideLight(): LightSource {
	return new LegacyLightSource([0.75, -2, 0], 0.18, true);
}

export function legacyFrontLight(): LightSource {
	return new LegacyLightSource([0, 0, 1], 1, false);
}

export const LightingProfile = {
	/** renderchest master (v5.2.0-beta.3): vanilla-accurate two-direction diffuse. */
	modern: 'modern',
	/** v2.5.2–v5.1.0: single-direction side light, inactive front light. */
	legacy: 'legacy',
} as const;

export type LightingProfileName = keyof typeof LightingProfile;

export function lightsForProfile(profile: LightingProfileName): { front: LightSource; side: LightSource; } {
	if (profile === 'legacy') {
		return { front: legacyFrontLight(), side: legacySideLight() };
	}
	return { front: guiFrontLight(), side: guiSideLight() };
}
