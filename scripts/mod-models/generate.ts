/**
 * Turns extracted part tables into assets/mod-models entries.
 *
 * Geometry keeps Java's handedness — boxes are the raw addBox bounds — and the
 * renderer's whole PoseStack sequence is folded into each element's single
 * rotation by pose.ts. That keeps the UVs as the plain entity-sheet unwrap with
 * no mirroring, and means a spec states the pose as the op list the renderer
 * actually runs.
 */
import fs from 'node:fs';
import path from 'node:path';

import { extractPartTables } from './extract.ts';
import {
	compose,
	decompose,
	poseTransform,
	rotationMatrix,
} from './pose.ts';
import { JarResourceManager } from '../../src/resources/jar.ts';
import { ResourceLocator } from '../../src/resources/locator.ts';

import type { Cube, Part, PartTable } from './extract.ts';
import type { PoseOp, Transform } from './pose.ts';

export interface Group {
	/** Part names; the first group with no `parts` catches everything left. */
	parts?: string[];
	emissive?: boolean;
	alpha?: number;
}

export interface Repeat {
	/** Ops appended to the pose for this instance, outside the part's offset. */
	pose?: PoseOp[];
	/** Replaces the part's Y rotation, in degrees. */
	yRot?: number;
}

export interface ItemSpec {
	id: string;
	jar: string;
	/** Class-path suffix of the entity-model class, e.g. 'model/ModelJetpack.class'. */
	modelClass: string;
	texture: string;
	/**
	 * The renderer's PoseStack ops, outermost first, verbatim. Defaults to the
	 * common ISTER pose: translate(0.5, 0.5, 0.5) then Axis.ZP 180°.
	 */
	pose?: PoseOp[];
	/**
	 * Extra ops for named parts, appended to `pose`. Models that pose parts
	 * individually inside their own render() need this — Botania's bellows moves
	 * its top, and its pylons pose the crystal apart from the ring.
	 */
	partPoses?: Record<string, PoseOp[]>;
	/**
	 * Parts a model draws more than once, one entry per instance. Botania's
	 * brewery sweeps its plate around a circle by assigning ModelPart.yRot, which
	 * replaces whatever the PartPose set, hence `yRot` rather than another op.
	 */
	repeat?: Record<string, Repeat[]>;
	groups?: Group[];
	/** Override when the sheet size is registered outside the model class. */
	sheet?: [number, number];
	/** Parts the item context never draws. */
	skip?: string[];
	guiLight?: 'front' | 'side';
}

const RADIANS_TO_DEGREES = 180 / Math.PI;

/** MekanismISTER's pose, and the common shape for item-only entity models. */
const DEFAULT_POSE: PoseOp[] = [
	{ translate: [0.5, 0.5, 0.5] },
	{ rotate: 'z', degrees: 180 },
];

/** Part offset then part rotation, in the part's own frame. */
function partTransform(part: Part, yRotOverride?: number): Transform {
	const offset = part.offset ?? [0, 0, 0];
	const rot = part.rot ?? [0, 0, 0];
	const degrees: Record<'x' | 'y' | 'z', number> = {
		x: rot[0] * RADIANS_TO_DEGREES,
		y: yRotOverride ?? rot[1] * RADIANS_TO_DEGREES,
		z: rot[2] * RADIANS_TO_DEGREES,
	};
	let linear = [1, 0, 0, 0, 1, 0, 0, 0, 1];
	// ModelPart.translateAndRotate multiplies Z, then Y, then X.
	for (const axis of ['z', 'y', 'x'] as const) {
		if (degrees[axis]) {
			linear = compose(
				{ linear, translation: [0, 0, 0] },
				{ linear: rotationMatrix(axis, degrees[axis]), translation: [0, 0, 0] },
			).linear;
		}
	}
	return { linear, translation: [offset[0], offset[1], offset[2]] };
}

function round(value: number): number {
	return Math.round(value * 100000) / 100000;
}

/**
 * Standard entity-sheet unwrap in Java model axes. Row at `v` is down then up
 * (each w×d); row at `v + d` is west (d), north (w), east (d), south (w).
 */
function faceUvs(baseU: number, baseV: number, width: number, height: number, depth: number): Record<string, number[]> {
	// Row at baseV: down then up, each width x depth. Row at baseV + depth:
	// west (depth), north (width), east (depth), south (width).
	const sideV = baseV + depth;
	const bottomV = sideV + height;
	const northU = baseU + depth;
	const eastU = northU + width;
	const southU = eastU + depth;
	return {
		down: [northU, baseV, eastU, sideV],
		up: [eastU, baseV, eastU + width, sideV],
		west: [baseU, sideV, northU, bottomV],
		north: [northU, sideV, eastU, bottomV],
		east: [eastU, sideV, southU, bottomV],
		south: [southU, sideV, southU + width, bottomV],
	};
}

function groupFor(name: string, groups: Group[]): Group {
	return groups.find(group => group.parts?.includes(name))
		?? groups.find(group => !group.parts)
		?? {};
}

export async function buildModel(spec: ItemSpec, root: string): Promise<number> {
	const [table] = extractPartTables(spec.jar, spec.modelClass);
	if (!table) {
		throw new Error(`no part table extracted from ${spec.modelClass} in ${spec.jar}`);
	}
	const sheet = spec.sheet ?? [table.textureWidth, table.textureHeight];
	if (!sheet[0] || !sheet[1]) {
		throw new Error(`unknown sheet size for ${spec.id}; pass \`sheet\``);
	}
	const groups = spec.groups ?? [{}];
	const skip = new Set(spec.skip);
	const baseOps = spec.pose ?? DEFAULT_POSE;
	const poseFor = (name: string, instance: Repeat): Transform => poseTransform([...baseOps, ...spec.partPoses?.[name] ?? [], ...instance.pose ?? []]);
	const locator = ResourceLocator.parse(spec.id);

	// The override replaces the jar's builtin/entity stub outright, so its
	// display transforms have to come along verbatim.
	const jar = new JarResourceManager(spec.jar);
	let display: unknown;
	try {
		const raw = await jar.getResource('model', new ResourceLocator(locator.namespace, `item/${locator.path}`));
		if (!raw) {
			throw new Error(`no item model for ${spec.id} in ${spec.jar}`);
		}
		display = (JSON.parse(raw.toString('utf8')) as { display?: unknown; }).display;
	} finally {
		await jar.close().catch(() => {});
	}

	const elements: unknown[] = [];
	for (const part of table.parts) {
		if (skip.has(part.name)) {
			continue;
		}
		const group = groupFor(part.name, groups);
		for (const instance of spec.repeat?.[part.name] ?? [{}]) {
		// Full chain for this part, then split into what one element can carry:
		// place the scaled box at `origin` and rotate about it.
			const full = compose(poseFor(part.name, instance), partTransform(part, instance.yRot));
			const { scale, euler } = decompose(full.linear);
			const origin = full.translation;

			for (const cube of part.cubes) {
				const [boxX, boxY, boxZ, width, height, depth] = cube.box;
				const grow = cube.inflate ?? 0;
				const faces: Record<string, unknown> = {};
				for (const [direction, rect] of Object.entries(faceUvs(cube.texOffs[0], cube.texOffs[1], width, height, depth))) {
					faces[direction] = {
						texture: '#texture',
						uv: [
							round(rect[0] * 16 / sheet[0]),
							round(rect[1] * 16 / sheet[1]),
							round(rect[2] * 16 / sheet[0]),
							round(rect[3] * 16 / sheet[1]),
						],
					};
				}
				elements.push({
					name: part.name,
					from: [
						round((boxX - grow) * scale + origin[0]),
						round((boxY - grow) * scale + origin[1]),
						round((boxZ - grow) * scale + origin[2]),
					],
					to: [
						round((boxX + width + grow) * scale + origin[0]),
						round((boxY + height + grow) * scale + origin[1]),
						round((boxZ + depth + grow) * scale + origin[2]),
					],
					rotation: {
						origin: origin.map(round),
						...(round(euler[0]) && { x: round(euler[0]) }),
						...(round(euler[1]) && { y: round(euler[1]) }),
						z: round(euler[2]),
					},
					...(group.emissive && { emissive_rc: true }),
					...(group.alpha !== undefined && { alpha_rc: round(group.alpha) }),
					faces,
				});
			}
		}
	}

	const model = {
		gui_light: spec.guiLight ?? 'side',
		textures: { texture: spec.texture },
		display,
		elements,
	};
	const out = path.join(root, locator.namespace, 'models', 'item');
	fs.mkdirSync(out, { recursive: true });
	fs.writeFileSync(path.join(out, `${locator.path.replace(/^item\//, '')}.json`), `${JSON.stringify(model, null, '\t')}\n`);
	return elements.length;
}
