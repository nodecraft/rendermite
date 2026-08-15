/**
 * Collapses a renderer's PoseStack sequence into what one model element can
 * express: a uniform scale, a rotation, and a translation.
 *
 * An element carries exactly one rotation about one origin, so a chain like
 * Mekanism's `translate(0.5,0.5,0.5); mulPose(ZP, 180°)` or Botania's
 * `translate(0.5,1.5,0.5); scale(1,-1,-1)` has to be folded into that shape.
 * Both are rigid (a mirror on two axes is a 180° rotation, determinant +1), so
 * the composite is always `p -> C + s·M·p` for a rotation M — which an element
 * expresses as: place the box at `s·box + C` and rotate about `C` by M.
 *
 * All lengths here are in the 0–16 space model JSON uses; `translate` ops are
 * given in block units and scaled on the way in, matching PoseStack.
 */

export type PoseOp =
	| { translate: [number, number, number]; }
	| { scale: [number, number, number]; }
	| { rotate: 'x' | 'y' | 'z'; degrees: number; }
	/** Quaternionf.rotateAxis — the axis need not be a cardinal one. */
	| { rotateAxis: [number, number, number]; degrees: number; };

/** Row-major 3x3 rotation/scale part plus a translation column. */
export interface Transform {
	linear: number[];
	translation: [number, number, number];
}

const DEGREES_TO_RADIANS = Math.PI / 180;

export function identity(): Transform {
	return { linear: [1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] };
}

function multiplyLinear(left: number[], right: number[]): number[] {
	const out = Array.from({ length: 9 }, () => 0);
	for (let row = 0; row < 3; row++) {
		for (let column = 0; column < 3; column++) {
			let sum = 0;
			for (let index = 0; index < 3; index++) {
				sum += left[row * 3 + index] * right[index * 3 + column];
			}
			out[row * 3 + column] = sum;
		}
	}
	return out;
}

export function applyLinear(linear: number[], vector: [number, number, number]): [number, number, number] {
	return [
		linear[0] * vector[0] + linear[1] * vector[1] + linear[2] * vector[2],
		linear[3] * vector[0] + linear[4] * vector[1] + linear[5] * vector[2],
		linear[6] * vector[0] + linear[7] * vector[1] + linear[8] * vector[2],
	];
}

export function compose(left: Transform, right: Transform): Transform {
	const moved = applyLinear(left.linear, right.translation);
	return {
		linear: multiplyLinear(left.linear, right.linear),
		translation: [
			left.translation[0] + moved[0],
			left.translation[1] + moved[1],
			left.translation[2] + moved[2],
		],
	};
}

export function rotationMatrix(axis: 'x' | 'y' | 'z', degrees: number): number[] {
	const angle = degrees * DEGREES_TO_RADIANS;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	if (axis === 'x') {
		return [1, 0, 0, 0, cos, -sin, 0, sin, cos];
	}
	if (axis === 'y') {
		return [cos, 0, sin, 0, 1, 0, -sin, 0, cos];
	}
	return [cos, -sin, 0, sin, cos, 0, 0, 0, 1];
}

/** Rodrigues' rotation for an arbitrary axis; the axis is normalized here. */
export function axisRotationMatrix(axis: [number, number, number], degrees: number): number[] {
	const length = Math.hypot(axis[0], axis[1], axis[2]);
	if (length === 0) {
		throw new Error('rotateAxis needs a non-zero axis');
	}
	const [ax, ay, az] = axis.map(value => value / length);
	const angle = degrees * DEGREES_TO_RADIANS;
	const cos = Math.cos(angle);
	const sin = Math.sin(angle);
	const rest = 1 - cos;
	return [
		cos + ax * ax * rest,
		ax * ay * rest - az * sin,
		ax * az * rest + ay * sin,
		ay * ax * rest + az * sin,
		cos + ay * ay * rest,
		ay * az * rest - ax * sin,
		az * ax * rest - ay * sin,
		az * ay * rest + ax * sin,
		cos + az * az * rest,
	];
}

/** A renderer's op list, innermost-last, exactly as PoseStack applies them. */
export function poseTransform(ops: PoseOp[]): Transform {
	let result = identity();
	for (const op of ops) {
		if ('translate' in op) {
			result = compose(result, {
				linear: identity().linear,
				// PoseStack.translate takes block units; elements are 0-16.
				translation: [op.translate[0] * 16, op.translate[1] * 16, op.translate[2] * 16],
			});
		} else if ('scale' in op) {
			result = compose(result, {
				linear: [op.scale[0], 0, 0, 0, op.scale[1], 0, 0, 0, op.scale[2]],
				translation: [0, 0, 0],
			});
		} else if ('rotateAxis' in op) {
			result = compose(result, { linear: axisRotationMatrix(op.rotateAxis, op.degrees), translation: [0, 0, 0] });
		} else {
			result = compose(result, { linear: rotationMatrix(op.rotate, op.degrees), translation: [0, 0, 0] });
		}
	}
	return result;
}

export interface Decomposed {
	/** Uniform scale factor pulled out of the linear part. */
	scale: number;
	/** Degrees, to be applied X then Y then Z — the model format's order. */
	euler: [number, number, number];
}

/**
 * Splits a linear part into a uniform scale and ZYX Euler angles. Throws rather
 * than approximating: a non-uniform scale or a true reflection cannot be put
 * into an element, and silently rounding one would ship a wrong icon.
 */
export function decompose(linear: number[]): Decomposed {
	const columnLength = (index: number): number => Math.hypot(linear[index], linear[index + 3], linear[index + 6]);
	const scales = [columnLength(0), columnLength(1), columnLength(2)];
	const scale = (scales[0] + scales[1] + scales[2]) / 3;
	for (const value of scales) {
		if (Math.abs(value - scale) > 1e-6) {
			throw new Error(`pose has a non-uniform scale (${scales.join(', ')}); not expressible in one element`);
		}
	}
	const rotation = linear.map(value => value / scale);
	const determinant = rotation[0] * (rotation[4] * rotation[8] - rotation[5] * rotation[7])
		- rotation[1] * (rotation[3] * rotation[8] - rotation[5] * rotation[6])
		+ rotation[2] * (rotation[3] * rotation[7] - rotation[4] * rotation[6]);
	if (determinant < 0) {
		throw new Error('pose contains a reflection; not expressible as an element rotation');
	}

	// R = Rz(c) * Ry(b) * Rx(a), so r20 = -sin(b) and the rest follows.
	const [r00, r01, r02, r10, r11, r12, r20, r21, r22] = rotation;
	const clamped = Math.min(1, Math.max(-1, -r20));
	const beta = Math.asin(clamped);
	let alpha: number;
	let gamma: number;
	if (Math.abs(clamped) > 1 - 1e-9) {
		// Gimbal lock: pitch is ±90°, so roll and yaw are not independent.
		alpha = Math.atan2(-r12, r11);
		gamma = 0;
	} else {
		alpha = Math.atan2(r21, r22);
		gamma = Math.atan2(r10, r00);
	}
	const toDegrees = 180 / Math.PI;
	return { scale, euler: [alpha * toDegrees, beta * toDegrees, gamma * toDegrees] };
}
