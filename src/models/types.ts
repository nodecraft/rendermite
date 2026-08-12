/**
 * Raw Minecraft block/item model JSON, as found in `assets/<ns>/models/`.
 * Field semantics: https://minecraft.wiki/w/Model — stable since 1.8, with
 * `gui_light` added in 1.15 and loader-specific extensions ignored here.
 */

export type Vec3 = [number, number, number];
export type Vec4 = [number, number, number, number];

export const FaceDirection = {
	down: 'down',
	up: 'up',
	north: 'north',
	south: 'south',
	west: 'west',
	east: 'east',
} as const;

export type FaceDirectionName = keyof typeof FaceDirection;

export interface ModelFaceJson {
	/** Texture reference (`#name`) or direct locator. */
	texture: string;
	/** [x1, y1, x2, y2] in 0–16 texture space; derived from the element bounds when absent. */
	uv?: Vec4;
	cullface?: string;
	/** UV rotation in degrees: 0, 90, 180, 270. */
	rotation?: number;
	/** Index into the model's tint layers; -1/absent = untinted. */
	tintindex?: number;
}

export interface ElementRotationJson {
	origin: Vec3;
	axis: 'x' | 'y' | 'z';
	/** -45 to 45 in 22.5 steps in vanilla; mods ship arbitrary angles. */
	angle: number;
	rescale?: boolean;
}

export interface ModelElementJson {
	/** Corner coordinates in 0–16 block space (mods exceed the range). */
	from: Vec3;
	to: Vec3;
	rotation?: ElementRotationJson;
	shade?: boolean;
	light_emission?: number;
	faces: Partial<Record<FaceDirectionName, ModelFaceJson>>;
}

export interface DisplayTransformJson {
	/** Degrees, applied x then y then z. */
	rotation?: Vec3;
	translation?: Vec3;
	scale?: Vec3;
}

export type DisplayPosition =
	| 'gui'
	| 'ground'
	| 'fixed'
	| 'head'
	| 'firstperson_righthand'
	| 'firstperson_lefthand'
	| 'thirdperson_righthand'
	| 'thirdperson_lefthand';

export interface ModelJson {
	parent?: string;
	ambientocclusion?: boolean;
	/** `front` renders items like flat sprites, `side` like blocks. */
	gui_light?: 'front' | 'side';
	display?: Partial<Record<DisplayPosition, DisplayTransformJson>>;
	/** name → locator or `#reference`. */
	textures?: Record<string, string>;
	elements?: ModelElementJson[];
	overrides?: Array<{ predicate: Record<string, number>; model: string; }>;
	/** Loader-specific extension point (forge/neoforge); handled by the mods layer. */
	loader?: string;
}
