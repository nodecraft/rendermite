/**
 * The shape an entity model comes out as, whichever source produced it.
 *
 * Two do: `model-bytecode.ts` interprets the Java that vanilla and most mods build their models in,
 * and `geo-model.ts` converts the bedrock `.geo.json` a GeckoLib mod ships instead. Both land here, in
 * **Java entity model space** — pixels, y measured *downwards* from 1.5 blocks above the mob's feet, a
 * part's pivot relative to its parent's — because that is the space a consumer has to draw in anyway.
 */

/** The six faces a box can carry its own texture rect on. */
export type CubeFace = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';

/** One box of a part, in the model's own space. */
export interface Cube {
	origin: [number, number, number];
	size: [number, number, number];
	/** Texture offset in pixels, as `texOffs`/`setTextureOffset` set it. */
	uv: [number, number];
	/** `CubeDeformation`/`delta`: grows the box on every side. */
	inflate: number;
	mirror: boolean;
	/**
	 * Per-face texture rects, which replace the box unwrap `uv` implies when present.
	 *
	 * Java has no such thing: `addBox` always unwraps the same way. Bedrock geometry does, and uses it
	 * heavily — 56% of the cubes in a corpus of GeckoLib mods — so a consumer that ignores this draws
	 * over half of every modded mob with the wrong part of its sheet.
	 */
	faces?: Partial<Record<CubeFace, { uv: [number, number]; size: [number, number]; }>>;
}

export interface Part {
	name: string;
	/** Where the part pivots, relative to its parent. */
	pivot: [number, number, number];
	/** Radians, as `PartPose.offsetAndRotation` states them. */
	rotation: [number, number, number];
	cubes: Cube[];
	children: Part[];
}

export interface ExtractedModel {
	textureSize: [number, number];
	parts: Part[];
	/** Why nothing came out, or what was skipped. */
	notes: string[];
}
