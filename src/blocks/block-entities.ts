/**
 * Geometry for blocks the game draws from Java rather than from a model.
 *
 * A chest's blockstate is `{"variants":{"":{"model":"block/chest"}}}` and that
 * model has no elements: the shape, the facing, and the pairing of a double
 * chest all live in a block entity renderer. Same for beds, banners, shulker
 * boxes, skulls and signs — 137 of vanilla's 1,107 blocks. A world viewer
 * reading only the assets would put a hole where every chest is.
 *
 * rendermite already vendors box geometry for most of these, because the icon
 * pipeline has the same problem and solved it years ago (`src/builtin.ts`,
 * `assets/builtin/`). This maps it onto blocks and synthesises the orientation
 * variants vanilla's blockstate file does not carry — the consumer knows the
 * block's real property map from the chunk, so it can pick.
 *
 * Everything here is a curated approximation, and the pack says so: each
 * substituted block lands in the failures sidecar, and the emitted model is
 * named `rendermite:block/…` so it is never mistaken for something a jar
 * shipped.
 */

import {
	DYE_COLORS,
	HEAD_LAYOUTS,
	coversSheet,
	findBedTexture,
	findChestTexture,
	findEntityTexture,
	findFluidSibling,
	findFluidStill,
	findMobTexture,
} from '../resources/entity-textures.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { ModelLoader } from '../models/loader.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { TextureLoader } from '../textures/loader.ts';

/**
 * What the table is allowed to look at. The vanilla families are a lookup, but
 * a mod's chest or mob head is only findable by searching its own assets, so
 * the table needs the pack in hand rather than just the block's name.
 */
export interface GeometryContext {
	resources: ResourceManager;
	textures: TextureLoader;
	models: ModelLoader;
}

/** How a block's own properties turn into a rotation of the vendored model. */
export type Orientation =
	/** One shape, no property to read. */
	| { kind: 'fixed'; }
	/**
	 * `facing` around the vertical axis. `authored` is the direction the
	 * vendored model already points, so the rest are offsets from it.
	 */
	| { kind: 'facing'; authored: 'north' | 'south' | 'east' | 'west'; }
	/** `facing` in all six directions, as a shulker box has. */
	| { kind: 'facing6'; }
	/** `rotation` 0–15 in 22.5 degree steps, as a standing banner or skull has. */
	| { kind: 'rotation16'; };

export interface BlockEntityShape {
	/** Vendored model drawn in place of the empty one. */
	model: string;
	/**
	 * A further property split, multiplied with the orientation. A bed is two
	 * blocks with a model each, told apart by `part`.
	 */
	when?: Record<string, string>;
	/** Bindings for this shape alone, merged over the geometry's own. */
	textures?: Record<string, string>;
	/**
	 * Offset applied to the model's elements, in model units. Lets a skull reuse
	 * the mobheads geometry, which is centred for an item's hand rather than
	 * sat on the floor or hung on a wall.
	 */
	translate?: [number, number, number];
}

export interface BlockEntityGeometry {
	/** Usually one; more where a property picks between shapes. */
	shapes: BlockEntityShape[];
	/** Texture variables to bind where the vendored model leaves them open. */
	textures?: Record<string, string>;
	orient: Orientation;
	/**
	 * Marks the substitute as a stand-in for a fluid, whose real surface the
	 * consumer has to mesh from neighbours. The emitted model says so, and names
	 * the sheets to mesh it with.
	 */
	fluid?: { overlay?: string; };
}

/**
 * Blocks that export empty because the game genuinely draws nothing for them,
 * or draws something no model format can express. Kept apart from the blocks
 * that came out empty by accident, so a consumer can tell a deliberate hole
 * from a gap in this exporter.
 */
export const INVISIBLE_BLOCKS: Record<string, string> = {
	'minecraft:air': 'nothing to draw',
	'minecraft:cave_air': 'nothing to draw',
	'minecraft:void_air': 'nothing to draw',
	'minecraft:barrier': 'only drawn while the player holds one',
	'minecraft:light': 'only drawn while the player holds one',
	'minecraft:structure_void': 'only drawn inside the structure block UI',
	'minecraft:moving_piston': 'a placeholder; the moving block is drawn by the piston',
	'minecraft:end_portal': 'a shader effect, not geometry',
	'minecraft:end_gateway': 'a shader effect, not geometry',
};

/** Clockwise from north, matching how a blockstate's `y` rotates a model. */
const FACING_DEGREES: Record<string, number> = { north: 0, east: 90, south: 180, west: 270 };

/** `facing6` for a shulker box: `up` is the shape as authored. */
const FACING6_ROTATION: Record<string, { x: number; y: number; }> = {
	up: { x: 0, y: 0 },
	down: { x: 180, y: 0 },
	north: { x: 270, y: 0 },
	south: { x: 90, y: 0 },
	east: { x: 90, y: 90 },
	west: { x: 90, y: 270 },
};

export interface SynthesizedVariant {
	when: Record<string, string>;
	x: number;
	y: number;
}

/**
 * The blockstate cases to emit for a substituted block. One per orientation the
 * block can be placed in, so a consumer holding the real property map from the
 * chunk finds the case the game would have used.
 */
export function synthesizeVariants(orient: Orientation): SynthesizedVariant[] {
	switch (orient.kind) {
		case 'fixed': {
			return [{ when: {}, x: 0, y: 0 }];
		}
		case 'facing': {
			const authored = FACING_DEGREES[orient.authored];
			return Object.entries(FACING_DEGREES).map(([facing, degrees]) => {
				return {
					when: { facing },
					x: 0,
					y: (degrees - authored + 360) % 360,
				};
			});
		}
		case 'facing6': {
			return Object.entries(FACING6_ROTATION).map(([facing, rotation]) => {
				return {
					when: { facing },
					x: rotation.x,
					y: rotation.y,
				};
			});
		}
		case 'rotation16': {
			return Array.from({ length: 16 }, (_, step) => {
				return {
					when: { rotation: String(step) },
					x: 0,
					// A blockstate's `y` is whole degrees, so the odd steps land on
					// the nearest of them. Vanilla's own banner is drawn by a block
					// entity at the exact angle; nothing in the format can say 22.5.
					y: Math.round(step * 22.5),
				};
			});
		}
	}
}

const CHEST_VARIANTS: Record<string, string> = {
	'minecraft:chest': 'chest',
	'minecraft:trapped_chest': 'trapped_chest',
	'minecraft:ender_chest': 'ender_chest',
	'minecraft:copper_chest': 'copper_chest',
	'minecraft:exposed_copper_chest': 'exposed_copper_chest',
	'minecraft:weathered_copper_chest': 'weathered_copper_chest',
	'minecraft:oxidized_copper_chest': 'oxidized_copper_chest',
	// Waxing a copper chest stops it weathering; it looks the same.
	'minecraft:waxed_copper_chest': 'copper_chest',
	'minecraft:waxed_exposed_copper_chest': 'exposed_copper_chest',
	'minecraft:waxed_weathered_copper_chest': 'weathered_copper_chest',
	'minecraft:waxed_oxidized_copper_chest': 'oxidized_copper_chest',
};

/** Base entity sheet per chest variant, which the double halves suffix. */
const CHEST_SHEETS: Record<string, string> = {
	chest: 'minecraft:entity/chest/normal',
	trapped_chest: 'minecraft:entity/chest/trapped',
	ender_chest: 'minecraft:entity/chest/ender',
	// The weathering stage trails the word on the sheet but leads it in the
	// block name, so these cannot be derived from one another.
	copper_chest: 'minecraft:entity/chest/copper',
	exposed_copper_chest: 'minecraft:entity/chest/copper_exposed',
	weathered_copper_chest: 'minecraft:entity/chest/copper_weathered',
	oxidized_copper_chest: 'minecraft:entity/chest/copper_oxidized',
};

/** Where a skull's block name does not match the mobheads model's. */
const SKULL_MOBS: Record<string, string> = { dragon: 'ender_dragon' };

const FLUID_SPRITES: Record<string, { sprite: string; tinted: boolean; }> = {
	'minecraft:water': { sprite: 'minecraft:block/water_still', tinted: true },
	'minecraft:bubble_column': { sprite: 'minecraft:block/water_still', tinted: true },
	'minecraft:lava': { sprite: 'minecraft:block/lava_still', tinted: false },
};

const DYE_COLOURS = new Set(Object.keys(DYE_COLORS));
const SHULKER_COLOURS = DYE_COLOURS;

/**
 * The vendored chest is authored with its latch on the south face, so a
 * `facing=south` chest needs no rotation. Verified by rendering, not by
 * reading the model.
 */
const CHEST_AUTHORED: Orientation = { kind: 'facing', authored: 'south' };

/**
 * Two chests placed side by side become one double chest: each keeps its own
 * block but takes a `type` of `left` or `right`, and the game swaps in a wider
 * box on a wider sheet so the pair reads as a single container with one lock on
 * the seam. Drawing two singles instead leaves a visible join and two lids.
 *
 * The halves are only offered where the sheets exist — an ender chest never
 * doubles and ships none — and the exporter drops a shape it cannot bind.
 */
async function chestGeometry(blockId: string, context: GeometryContext): Promise<BlockEntityGeometry | null> {
	const [namespace, name] = blockId.split(':', 2);
	const variant = CHEST_VARIANTS[blockId];
	// A mod's chest is found the way the icon renderer finds one: by searching
	// its own textures, because `ironchest:crystal_chest` keeps its sheet
	// wherever it likes and no table could list them. Never a chestplate.
	const searchable = /chest|crate/.test(name) && !name.includes('chestplate');
	const found = variant === undefined && searchable
		? await findChestTexture(context.resources, namespace, name)
		: null;
	const sheet = variant === undefined ? found?.toString() : CHEST_SHEETS[variant];
	if (sheet === undefined) {
		return null;
	}
	// The single form is the vendored wrapper where there is one, and the bare
	// geometry with the found sheet bound where there is not.
	const single: BlockEntityShape = variant === undefined
		? { model: 'renderchest:item/chest', textures: { texture: sheet } }
		: { model: `renderchest:item/chest/${variant}` };
	const [left, right] = await Promise.all([
		halfSheet(sheet, 'left', context),
		halfSheet(sheet, 'right', context),
	]);
	// A chest with no paired sheets never doubles — an ender chest — or the mod
	// draws its pair some other way. Either way one unkeyed shape is right: it
	// matches whatever `type` the consumer holds, so the block still draws.
	if (left === null || right === null) {
		return { shapes: [single], orient: CHEST_AUTHORED };
	}
	return {
		shapes: [
			{ ...single, when: { type: 'single' } },
			{ model: 'renderchest:block/chest_left', when: { type: 'left' }, textures: { texture: left } },
			{ model: 'renderchest:block/chest_right', when: { type: 'right' }, textures: { texture: right } },
		],
		orient: CHEST_AUTHORED,
	};
}

/**
 * The wider sheet for one half of a double chest. Vanilla suffixes the base
 * name (`normal` → `normal_left`); quark files the halves beside it instead
 * (`acacia/normal` → `acacia/left`). Both are common enough to try.
 */
async function halfSheet(sheet: string, side: 'left' | 'right', context: GeometryContext): Promise<string | null> {
	const base = ResourceLocator.parse(sheet);
	const sibling = base.path.includes('/')
		? `${base.path.slice(0, base.path.lastIndexOf('/'))}/${side}`
		: side;
	for (const path of [`${base.path}_${side}`, sibling]) {
		const candidate = new ResourceLocator(base.namespace, path);
		if (await context.resources.hasResource('texture', candidate)) {
			return candidate.toString();
		}
	}
	return null;
}

/**
 * A banner's colour is a tint over one greyscale sheet, not 16 textures, so the
 * two forms share a model each and the tint table carries the dye.
 */
async function bannerGeometry(blockId: string, context: GeometryContext): Promise<BlockEntityGeometry | null> {
	const [namespace, name] = blockId.split(':', 2);
	const wall = name.endsWith('_wall_banner');
	if (!wall && !name.endsWith('_banner')) {
		return null;
	}
	// A mod banner with its own cloth sheet uses it; the rest fall back to
	// vanilla's greyscale base, which the tint table dyes for the 16 colours.
	// `entity/banner/base` is the one spelling every version from 1.13 on
	// agrees about; `entity/banner_base` was dropped after 1.21.
	const own = new ResourceLocator(namespace, 'entity/banner/base');
	const texture = namespace !== 'minecraft' && await context.resources.hasResource('texture', own)
		? own.toString()
		: 'minecraft:entity/banner/base';
	return {
		shapes: [{ model: `renderchest:block/banner_${wall ? 'wall' : 'standing'}` }],
		textures: { texture },
		// The cloth's front is its south face, so the wall form is authored on
		// the north side of its block and swings round to sit behind itself.
		orient: wall ? { kind: 'facing', authored: 'south' } : { kind: 'rotation16' },
	};
}

/**
 * The vendored heads were authored against current vanilla, which files an
 * entity sheet under its own mob folder (`entity/bat/bat`). Older versions keep
 * them flat (`entity/bat`), so a binding that does not resolve is looked up
 * again by name rather than left to export as magenta. The variable it is bound
 * to is whatever the model called it, which is why the map is read rather than
 * a name assumed.
 */
async function rebindMissingSheets(
	bindings: Record<string, string>,
	context: GeometryContext,
	mob: string,
): Promise<Record<string, string> | undefined> {
	const fixes: Record<string, string> = {};
	for (const [name, value] of Object.entries(bindings)) {
		const locator = ResourceLocator.tryParse(value);
		if (locator === null || await context.resources.hasResource('texture', locator)) {
			continue;
		}
		const leaf = locator.path.split('/').pop() ?? '';
		const found = await findMobTexture(context.resources, locator.namespace, leaf)
			?? await findMobTexture(context.resources, locator.namespace, mob);
		if (found !== null) {
			fixes[name] = found.toString();
		}
	}
	return Object.keys(fixes).length > 0 ? fixes : undefined;
}

/**
 * Skulls reuse the mobheads geometry the icon pipeline already vendors, which
 * is centred in the block for an item's hand. A block wants it on the floor or
 * against a wall, which is a translation rather than 90 more models.
 */
async function skullGeometry(blockId: string, context: GeometryContext): Promise<BlockEntityGeometry | null> {
	const [namespace, name] = blockId.split(':', 2);
	const match = /^(.+?)_(?:wall_)?(?:skull|head)$/.exec(name);
	if (match === null) {
		return null;
	}
	const mob = SKULL_MOBS[match[1]] ?? match[1];
	const wall = name.includes('_wall_');
	const place = (model: string, textures?: Record<string, string>): BlockEntityGeometry => {
		return {
			shapes: [{ model, textures, translate: wall ? [0, 0, 4] : [0, -4, 0] }],
			orient: wall ? { kind: 'facing', authored: 'north' } : { kind: 'rotation16' },
		};
	};

	/*
	 * A player head is the one head whose sheet is not fixed: the block entity names a profile, and a
	 * consumer that resolves it draws somebody's real skin on this geometry. So it takes the variant
	 * carrying the skin's own hat layer, which is half of a head that has one and which the plain
	 * `mobheads:item/player` — shared with the item icon, where the extra box fringes the render —
	 * does not have.
	 */
	const parts = (mob === 'player' ? 'player_skin' : mob).split('_');
	for (let keep = parts.length; keep >= 1 && keep >= parts.length - 2; keep--) {
		const model = `mobheads:item/${parts.slice(0, keep).join('_')}`;
		const resolved = await context.models.load(model).catch(() => null);
		if (resolved !== null) {
			return place(model, await rebindMissingSheets(resolved.textures, context, mob));
		}
	}

	// A mob the vendored pack has never heard of. The head is the same eight
	// pixels either way, so bind the mod's own sheet to the base geometry — but
	// only if it is a real skin layout, since anything else unwraps to confetti.
	const sheet = await findMobTexture(context.resources, namespace, mob);
	const skin = sheet === null ? null : await context.textures.load(sheet).catch(() => null);
	const base = skin === null ? undefined : HEAD_LAYOUTS[`${skin.width}x${skin.height}`];
	return sheet !== null && base !== undefined
		? place(`mobheads:item/base/${base}`, { texture: sheet.toString() })
		: null;
}

/**
 * 26.2's copper golem statue, which the game draws entirely from Java: an empty
 * variant on a model with only a particle texture, and no entity geometry data
 * in the jar either. `renderchest:block/copper_golem_statue` was authored from
 * the sheet's own unwrap for it.
 *
 * `copper_golem_pose` picks between standing, sitting, running and star, which
 * differ by limb rotations nothing in the assets records. Keying only on
 * `facing` means every pose draws the standing statue rather than a hole.
 */
async function copperGolemGeometry(blockId: string, context: GeometryContext): Promise<BlockEntityGeometry | null> {
	const name = blockId.split(':', 2)[1];
	const match = /^(?:waxed_)?(exposed_|weathered_|oxidized_)?copper_golem_statue$/.exec(name);
	if (match === null) {
		return null;
	}
	// Waxing stops a statue weathering; it looks the same as the stage it froze
	// at, so the sheet is named for the stage rather than the block.
	const stage = match[1] === undefined ? '' : `_${match[1].slice(0, -1)}`;
	const sheet = new ResourceLocator('minecraft', `entity/copper_golem/copper_golem${stage}`);
	if (!await context.resources.hasResource('texture', sheet)) {
		return null;
	}
	return {
		shapes: [{ model: 'renderchest:block/copper_golem_statue' }],
		textures: {
			texture: sheet.toString(),
			eyes: `minecraft:entity/copper_golem/copper_golem_eyes${stage}`,
		},
		orient: { kind: 'facing', authored: 'north' },
	};
}

/**
 * A fluid's surface height and flow direction come from its neighbours, which
 * no pack can carry, so the block is a plain culled cube: right wherever the
 * fluid is enclosed, two pixels tall at an open surface. The still and flow
 * sprites are in the atlas for a consumer that meshes fluids properly.
 */
async function fluidGeometry(blockId: string, context: GeometryContext): Promise<BlockEntityGeometry | null> {
	const [namespace, name] = blockId.split(':', 2);
	const known = FLUID_SPRITES[blockId];
	// Vanilla's two are tinted from the biome and named for it; a mod's fluid is
	// found by its own still sprite, and its texture already carries the colour.
	const found = known === undefined ? await findFluidStill(context.resources, namespace, name) : null;
	const still = known === undefined ? found : ResourceLocator.parse(known.sprite);
	if (still === null) {
		return null;
	}
	// The sides take the flow sheet, as `LiquidBlockRenderer` does. Naming both
	// on the model is also how a consumer that meshes fluids properly finds
	// them: guessing `<block>_flow` works for vanilla and fails for every mod.
	const flow = await findFluidSibling(context.resources, still, ['_flow', '_flowing']);
	const overlay = await findFluidSibling(context.resources, still, ['_overlay']);
	return {
		shapes: [{ model: `renderchest:block/fluid${known?.tinted ? '_tinted' : ''}` }],
		textures: { still: still.toString(), flow: (flow ?? still).toString() },
		orient: { kind: 'fixed' },
		fluid: overlay === null ? {} : { overlay: overlay.toString() },
	};
}

async function shulkerGeometry(blockId: string, context: GeometryContext): Promise<BlockEntityGeometry | null> {
	const [namespace, name] = blockId.split(':', 2);
	if (!name.includes('shulker') || name.includes('shell')) {
		return null;
	}
	if (name === 'shulker_box') {
		return {
			shapes: [{ model: 'renderchest:item/shulker_box' }],
			textures: { texture: 'minecraft:entity/shulker/shulker' },
			orient: { kind: 'facing6' },
		};
	}
	const colour = name.endsWith('_shulker_box') ? name.slice(0, -'_shulker_box'.length) : null;
	if (colour !== null && SHULKER_COLOURS.has(colour) && namespace === 'minecraft') {
		return { shapes: [{ model: `renderchest:item/shulker_box/${name}` }], orient: { kind: 'facing6' } };
	}
	// A mod sheet is only usable if it is a whole skin: tier overlays are meant
	// to composite over the vanilla box, and wearing one alone leaves nothing
	// but floating corners.
	const candidate = await findEntityTexture(context.resources, namespace, name, 'shulker');
	const sheet = candidate !== null && await coversSheet(context.textures, candidate)
		? candidate.toString()
		: 'minecraft:entity/shulker/shulker';
	return {
		shapes: [{ model: 'renderchest:item/shulker_box', textures: { texture: sheet } }],
		orient: { kind: 'facing6' },
	};
}

/**
 * Signs are the largest family the game draws in code — 48 blocks in vanilla —
 * and nothing was vendored for them, so `block/standing_sign` and
 * `block/wall_sign` were authored against the entity sheet's own box unwrap.
 *
 * The wood is read off the block name rather than listed, so a mod that follows
 * the same convention gets its signs for free; the exporter only substitutes
 * once it has checked the texture is really there.
 */
async function signGeometry(blockId: string, context: GeometryContext): Promise<BlockEntityGeometry | null> {
	const [namespace, name] = blockId.split(':', 2);
	if (name !== 'sign' && !name.endsWith('_sign')) {
		return null;
	}
	// Peeled in the order the name builds up: `oak_wall_hanging_sign` is a wall
	// form of a hanging sign made of oak. A hanging sign is a different shape on
	// its own sheet, and its wall form hangs from a bracket rather than a
	// ceiling bar — close enough at world scale to share the one model, rotated.
	// A 1.13 name has no wood at all, so each token can also be the whole of
	// what is left.
	let wood = name === 'sign' ? '' : name.slice(0, -'_sign'.length);
	const peel = (token: string): boolean => {
		if (wood !== token && !wood.endsWith(`_${token}`)) {
			return false;
		}
		wood = wood.slice(0, Math.max(0, wood.length - token.length - 1));
		return true;
	};
	const hanging = peel('hanging');
	const wall = peel('wall');
	const model = hanging ? 'hanging_sign' : (wall ? 'wall_sign' : 'standing_sign');
	// 1.13 had one sign, so the block carries no wood and the sheet is just
	// `entity/sign`. From 1.14 the wood is in both.
	const conventional = new ResourceLocator(namespace, wood.length === 0
		? 'entity/sign'
		: `entity/signs/${hanging ? 'hanging/' : ''}${wood}`);
	// Most mods follow the convention, so it is tried first and costs one
	// lookup. The rest get searched for, which is how cobblemon's apricorn
	// signs and quark's variants are found.
	const found = await context.resources.hasResource('texture', conventional)
		? conventional
		: await findEntityTexture(context.resources, namespace, `${wood}_${hanging ? 'hanging_' : ''}sign`, 'sign');
	if (found === null) {
		return null;
	}
	return {
		shapes: [{ model: `renderchest:block/${model}` }],
		textures: { texture: found.toString() },
		orient: wall ? { kind: 'facing', authored: 'north' } : { kind: 'rotation16' },
	};
}

/** Every dye a bed comes in; the sheet is named for it. */
const BED_COLOURS = SHULKER_COLOURS;

/**
 * A bed is two blocks with a model each, and `BedRenderer` draws both halves
 * from one entity model spanning them. `part` picks the half and `facing`
 * orients it, so the two multiply into eight cases.
 */
async function bedGeometry(blockId: string, context: GeometryContext): Promise<BlockEntityGeometry | null> {
	const [namespace, name] = blockId.split(':', 2);
	if (name !== 'bed' && !name.endsWith('_bed')) {
		return null;
	}
	const colour = name === 'bed' ? '' : name.slice(0, -'_bed'.length);
	const conventional = new ResourceLocator(namespace, `entity/bed/${colour}`);
	const found = BED_COLOURS.has(colour) && await context.resources.hasResource('texture', conventional)
		? conventional
		: await findBedTexture(context.resources, namespace, name);
	if (found === null) {
		return null;
	}
	return {
		shapes: [
			{ when: { part: 'head' }, model: 'renderchest:block/bed_head' },
			{ when: { part: 'foot' }, model: 'renderchest:block/bed_foot' },
		],
		textures: { texture: found.toString() },
		orient: { kind: 'facing', authored: 'north' },
	};
}

/**
 * Blocks with one shape and nothing to orient by. Vanilla ids draw vendored
 * geometry; a mod id is here only where the mod ships a model of its own that
 * describes the block and nothing points at it, the same bar `MOD_LOADER_HANDLERS`
 * uses for loaders.
 */
const FIXED: Record<string, BlockEntityGeometry> = {
	'minecraft:conduit': { shapes: [{ model: 'renderchest:item/conduit' }], orient: { kind: 'fixed' } },
	// AE2 builds the cable bus entirely in code: cable type, connections and every
	// attached part live in the block entity, so its model is `{}` and its item
	// model is too. The basic cable's centre core is the one piece of it the assets
	// do describe, and it puts a marker where a network runs instead of a hole
	// through the middle of every AE2 base.
	'ae2:cable_bus': { shapes: [{ model: 'ae2:part/cable/glass/center' }], orient: { kind: 'fixed' } },
	'minecraft:decorated_pot': {
		shapes: [{ model: 'renderchest:item/decorated_pot' }],
		// An undecorated pot: the sherd faces are per-block-entity NBT.
		textures: {
			base: 'minecraft:entity/decorated_pot/decorated_pot_base',
			north: 'minecraft:entity/decorated_pot/decorated_pot_side',
			south: 'minecraft:entity/decorated_pot/decorated_pot_side',
			west: 'minecraft:entity/decorated_pot/decorated_pot_side',
			east: 'minecraft:entity/decorated_pot/decorated_pot_side',
		},
		orient: { kind: 'fixed' },
	},
};

/**
 * The vendored geometry for a block the game draws in code, or null when there
 * is none and the block stays empty.
 */
export async function blockEntityGeometry(
	blockId: string,
	context: GeometryContext,
): Promise<BlockEntityGeometry | null> {
	const fixed = FIXED[blockId];
	if (fixed !== undefined) {
		return fixed;
	}
	// Ordered by how specific the name test is, so a `_shulker_box` is never
	// taken for a chest and a `_bed` is never taken for a mob head.
	const families = [chestGeometry, shulkerGeometry, signGeometry, bedGeometry, bannerGeometry, copperGolemGeometry, skullGeometry, fluidGeometry];
	for (const family of families) {
		const geometry = await family(blockId, context);
		if (geometry !== null) {
			return geometry;
		}
	}
	return null;
}
