/**
 * Vector/matrix math mirroring renderchest's Vector3/Matrix4 semantics exactly
 * (column-major 4x4, YXZ euler quaternions, w-divide only when w is not 0/1).
 * Kept as plain arrays/functions — these run in the hot path.
 */

export type Vec3 = [number, number, number];

/** Column-major, m[row + col * 4]. */
export type Mat4 = Float64Array;

export function vec3(x: number, y: number, z: number): Vec3 {
	return [x, y, z];
}

export function normalize(v: Vec3): Vec3 {
	const length = Math.hypot(v[0], v[1], v[2]);
	if (length === 0) {
		return [0, 0, 0];
	}
	return [v[0] / length, v[1] / length, v[2] / length];
}

export function dot(a: Vec3, b: Vec3): number {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
	return [
		a[1] * b[2] - a[2] * b[1],
		a[2] * b[0] - a[0] * b[2],
		a[0] * b[1] - a[1] * b[0],
	];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
	return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function identity(): Mat4 {
	const m = new Float64Array(16);
	m[0] = 1;
	m[5] = 1;
	m[10] = 1;
	m[15] = 1;
	return m;
}

/** this * other, both column-major. */
export function multiply(a: Mat4, b: Mat4): Mat4 {
	const out = new Float64Array(16);
	for (let col = 0; col < 4; col++) {
		for (let row = 0; row < 4; row++) {
			let sum = 0;
			for (let k = 0; k < 4; k++) {
				sum += a[row + k * 4] * b[k + col * 4];
			}
			out[row + col * 4] = sum;
		}
	}
	return out;
}

export function translation(x: number, y: number, z: number): Mat4 {
	const m = identity();
	m[12] = x;
	m[13] = y;
	m[14] = z;
	return m;
}

export function scaling(x: number, y: number, z: number): Mat4 {
	const m = identity();
	m[0] = x;
	m[5] = y;
	m[10] = z;
	return m;
}

export function rotationX(angle: number): Mat4 {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const m = identity();
	m[5] = c;
	m[9] = -s;
	m[6] = s;
	m[10] = c;
	return m;
}

export function rotationY(angle: number): Mat4 {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const m = identity();
	m[0] = c;
	m[8] = s;
	m[2] = -s;
	m[10] = c;
	return m;
}

export function rotationZ(angle: number): Mat4 {
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const m = identity();
	m[0] = c;
	m[4] = -s;
	m[1] = s;
	m[5] = c;
	return m;
}

/** Standard unit-quaternion rotation matrix. */
export function fromQuaternion(x: number, y: number, z: number, w: number): Mat4 {
	const m = identity();
	m[0] = 1 - 2 * (y * y + z * z);
	m[4] = 2 * (x * y - z * w);
	m[8] = 2 * (x * z + y * w);
	m[1] = 2 * (x * y + z * w);
	m[5] = 1 - 2 * (x * x + z * z);
	m[9] = 2 * (y * z - x * w);
	m[2] = 2 * (x * z - y * w);
	m[6] = 2 * (y * z + x * w);
	m[10] = 1 - 2 * (x * x + y * y);
	return m;
}

/** Euler → quaternion in YXZ order, matching Matrix4::rotateEulerRadians. */
export function rotationEuler(x: number, y: number, z: number): Mat4 {
	const cx = Math.cos(x / 2);
	const sx = Math.sin(x / 2);
	const cy = Math.cos(y / 2);
	const sy = Math.sin(y / 2);
	const cz = Math.cos(z / 2);
	const sz = Math.sin(z / 2);
	return fromQuaternion(
		sx * cy * cz + cx * sy * sz,
		cx * sy * cz - sx * cy * sz,
		cx * cy * sz - sx * sy * cz,
		cx * cy * cz + sx * sy * sz,
	);
}

/** Row · (x, y, z, 1), dividing by w only when w is neither 0 nor 1 (upstream quirk). */
export function transformVector(m: Mat4, v: Vec3): Vec3 {
	const x = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
	const y = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
	const z = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
	const w = m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15];
	if (w !== 0 && w !== 1) {
		return [x / w, y / w, z / w];
	}
	return [x, y, z];
}

/** Upper-left 3x3 only — for normals and light directions. */
export function transformDirection(m: Mat4, v: Vec3): Vec3 {
	return [
		m[0] * v[0] + m[4] * v[1] + m[8] * v[2],
		m[1] * v[0] + m[5] * v[1] + m[9] * v[2],
		m[2] * v[0] + m[6] * v[1] + m[10] * v[2],
	];
}

/**
 * Item-definition `transformation`: either a flat 16-number column-major array or
 * {translation, left_rotation quat, scale, right_rotation quat} applied in that order.
 */
export function fromItemTransform(data: unknown): Mat4 {
	if (Array.isArray(data) && data.length === 16 && data.every(n => typeof n === 'number')) {
		return Float64Array.from(data as number[]);
	}
	if (typeof data === 'object' && data !== null) {
		const record = data as {
			translation?: number[];
			left_rotation?: number[];
			scale?: number[];
			right_rotation?: number[];
		};
		let m = identity();
		if (record.translation) {
			m = multiply(m, translation(record.translation[0], record.translation[1], record.translation[2]));
		}
		if (record.left_rotation) {
			const [x, y, z, w] = record.left_rotation;
			m = multiply(m, fromQuaternion(x, y, z, w));
		}
		if (record.scale) {
			m = multiply(m, scaling(record.scale[0], record.scale[1], record.scale[2]));
		}
		if (record.right_rotation) {
			const [x, y, z, w] = record.right_rotation;
			m = multiply(m, fromQuaternion(x, y, z, w));
		}
		return m;
	}
	return identity();
}

/**
 * The gui display transform, pivot (0.5, 0.5, 0.5):
 * T(+.5) · T(translation/16) · S(scale) · Rz(-rz) · Rx(rx) · Ry(ry) · T(-.5)
 * — note the negated Z rotation and Y-innermost order, matching ModelDisplaySettings.
 */
export function displayMatrix(rotation: Vec3, translationVec: Vec3, scale: Vec3): Mat4 {
	const toRadians = Math.PI / 180;
	let m = translation(0.5, 0.5, 0.5);
	m = multiply(m, translation(translationVec[0] / 16, translationVec[1] / 16, translationVec[2] / 16));
	// Vanilla composes display rotation as rotationXYZ (Rx·Ry·Rz, so Z acts
	// first) with scale innermost. Upstream renderchest used Rz(-z)·Rx·Ry,
	// which coincides for the vanilla [x, y, 0] transforms but scrambles mod
	// models that actually use Z (mekanism's qio_dashboard [120, -180, -45]).
	m = multiply(m, rotationX(rotation[0] * toRadians));
	m = multiply(m, rotationY(rotation[1] * toRadians));
	m = multiply(m, rotationZ(rotation[2] * toRadians));
	m = multiply(m, scaling(scale[0], scale[1], scale[2]));
	m = multiply(m, translation(-0.5, -0.5, -0.5));
	return m;
}
