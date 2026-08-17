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
	/**
	 * Ours, not vanilla: an extra angle about the element's own rotation axis,
	 * folded into `rotation.angle` by the loader. Supplementaries writes it on
	 * its awnings to get an arbitrary slant past vanilla's 22.5 steps.
	 */
	extra_rotation?: number;
	shade?: boolean;
	light_emission?: number;
	/**
	 * Ours, not vanilla: skip directional shading for this element. Mods draw
	 * emissive parts in code with a fullbright render type (Mekanism's disassembler
	 * blade), which no vanilla model field can express.
	 */
	emissive_rc?: boolean;
	/** Ours, not vanilla: constant opacity multiplier for a translucent element. */
	alpha_rc?: number;
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
	/**
	 * Loader extension (forge/neoforge): the render layer this model draws on,
	 * stated rather than inferred. Vanilla has no equivalent.
	 */
	render_type?: string;
	/** name → locator or `#reference`. */
	textures?: Record<string, string>;
	elements?: ModelElementJson[];
	overrides?: Array<{ predicate: Record<string, number>; model: string; }>;
	/** Loader-specific extension point (forge/neoforge); handled by the mods layer. */
	loader?: string;
}
