/**
 * Block tint semantics for the exported pack.
 *
 * Blocks, unlike items, state none of this in their assets — vanilla registers
 * every tint in `BlockColors.createDefault()` in Java, so the mapping below is
 * hand-maintained against that method. Anything not in it exports untinted, and
 * `src/blocks/export.ts` records the gap in the failures sidecar so a missing
 * entry is visible rather than silent.
 *
 * The colour *values* are not hand-written: grass and foliage are sampled from
 * the version's own colormaps at plains' climate, so a pack always carries the
 * colours that version ships. `flat` is that one climate; the colormaps ride
 * along in the pack and `biomes.json` (see src/blocks/biomes.ts) says where in
 * one each biome reads, which is what makes a real per-biome tint possible.
 */

import { ResourceLocator } from '../resources/locator.ts';

import type { ResourceManager } from '../resources/manager.ts';
import type { TextureLoader } from '../textures/loader.ts';

export type BlockTint =
	/** Sample the named colormap at the block's biome climate. */
	| { kind: 'grass' | 'foliage' | 'dry_foliage'; }
	/** The biome's flat `water_color`. */
	| { kind: 'water'; }
	| { kind: 'constant'; color: string; }
	/** Index a ramp by the named blockstate property's numeric value. */
	| { kind: 'ramp'; ramp: 'redstone' | 'stem'; property: string; };

export interface BlockTintPack {
	/** Plains-climate colours, the flat tint a v1 consumer applies everywhere. */
	flat: Record<string, string>;
	/** Colormap name → file inside the pack; `biomes.json` says where in one to read. */
	colormaps: Record<string, string>;
	ramps: Record<string, string[]>;
	/** Block id → tintindex → semantics. */
	blocks: Record<string, Record<string, BlockTint>>;
}

/** Plains: the climate a v1 consumer tints everything at. */
const PLAINS_TEMPERATURE = 0.8;
const PLAINS_DOWNFALL = 0.4;
/** Plains' `water_color`, which lives in biome data rather than in assets. */
const PLAINS_WATER = '#3f76e4';

const GRASS_BLOCKS = [
	'grass_block',
	'short_grass',
	// Pre-1.20.3 name for short_grass.
	'grass',
	'fern',
	'tall_grass',
	'large_fern',
	'potted_fern',
	'sugar_cane',
	// 1.21.5. Grass rather than dry foliage, as its own item definition states.
	'bush',
];

const FOLIAGE_BLOCKS = ['oak_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'vine'];

/** 1.21.5's dry foliage, the third colormap. Older versions simply have neither block. */
const DRY_FOLIAGE_BLOCKS = ['leaf_litter'];

const WATER_BLOCKS = ['water', 'bubble_column', 'water_cauldron'];

/**
 * Blocks whose *stem* is grass-tinted while the flowers on it are not, so the
 * tint sits on `tintindex` 1 rather than 0. Nothing else in vanilla numbers a
 * tint above zero.
 */
const GRASS_STEM_BLOCKS = ['pink_petals', 'wildflowers'];

/**
 * Blocks with a `tintindex` vanilla registers no colour for, and why. The game
 * draws them untinted too — the index is inherited from a parent model or a
 * shared one — so the pack leaving them alone is correct rather than a gap, and
 * saying so here is what keeps a real gap visible in the failures sidecar.
 */
export const UNREGISTERED_TINTS: Record<string, string> = {
	bamboo: 'the stalk model carries an index vanilla never colours',
	bamboo_sapling: 'shares the bamboo stalk model',
	cherry_leaves: 'inherits an index from block/leaves and is meant to stay pink',
	pale_oak_leaves: 'inherits an index from block/leaves and is meant to stay pale',
	lava_cauldron: 'shares the water cauldron model; lava is not water-tinted',
	powder_snow_cauldron: 'shares the water cauldron model',
	stonecutter: 'the saw model carries an index vanilla never colours',
	// Mojang agreed in the end: 1.21 repointed kelp at block/cross, which has no
	// index at all. Seagrass lost its own the same way in 1.18.
	kelp: 'inherits an index from block/tinted_cross, which vanilla never colours it through',
	kelp_plant: 'shares the kelp model',
	seagrass: 'inherits an index from its pre-1.18 template model',
	tall_seagrass: 'shares the seagrass template',
};

/** Blocks whose tint vanilla hard-codes rather than reading from a colormap. */
const CONSTANT_TINTS: Record<string, string> = {
	spruce_leaves: '#619961',
	birch_leaves: '#80a755',
	lily_pad: '#208030',
	attached_melon_stem: '#e0c71c',
	attached_pumpkin_stem: '#e0c71c',
};

/**
 * `DyeColor.getTextureDiffuseColor`. A banner is one greyscale sheet the game
 * multiplies by the dye, which is why 16 colours cost one model and 32 entries
 * here rather than 32 models.
 */
const DYE_TEXTURE_COLORS: Record<string, string> = {
	white: '#f9fffe',
	orange: '#f9801d',
	magenta: '#c74ebd',
	light_blue: '#3ab3da',
	yellow: '#fed83d',
	lime: '#80c71f',
	pink: '#f38baa',
	gray: '#474f52',
	light_gray: '#9d9d97',
	cyan: '#169c9c',
	purple: '#8932b8',
	blue: '#3c44aa',
	brown: '#835432',
	green: '#5e7c16',
	red: '#b02e26',
	black: '#1d1d21',
};

function hex(red: number, green: number, blue: number): string {
	return `#${[red, green, blue].map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function clamp01(value: number): number {
	return Math.min(1, Math.max(0, value));
}

/** `RedStoneWireBlock.colorForPower`, for power levels 0–15. */
function redstoneRamp(): string[] {
	return Array.from({ length: 16 }, (_, power) => {
		const level = power / 15;
		const red = level * 0.6 + (level > 0 ? 0.4 : 0.3);
		return hex(red * 255, clamp01(level * level * 0.7 - 0.5) * 255, clamp01(level * level * 0.6 - 0.7) * 255);
	});
}

/** The age ramp `BlockColors` registers for melon and pumpkin stems. */
function stemRamp(): string[] {
	return Array.from({ length: 8 }, (_, age) => hex(age * 32, 255 - age * 8, age * 4));
}

/**
 * Vanilla's colormap lookup (`GrassColor.get` / `FoliageColor.get`): a climate
 * pair addresses the triangular half of a 256x256 map.
 */
async function sampleColormap(
	textures: TextureLoader,
	locator: ResourceLocator,
	temperature: number,
	downfall: number,
): Promise<string | null> {
	const texture = await textures.load(locator).catch(() => null);
	if (!texture) {
		return null;
	}
	// Vanilla addresses the map in 0–255 steps regardless of its size, so the
	// scale is 255 rather than the texture's own width — off by one otherwise,
	// and plains grass is a colour people recognise on sight.
	const x = Math.min(texture.width - 1, Math.floor((1 - temperature) * 255));
	const y = Math.min(texture.height - 1, Math.floor((1 - downfall * temperature) * 255));
	const offset = (y * texture.width + x) * 4;
	return hex(texture.data[offset], texture.data[offset + 1], texture.data[offset + 2]);
}

export interface BuiltBlockTints {
	pack: BlockTintPack;
	/** Colormap PNGs to copy into the pack, keyed by their path inside it. */
	files: Array<{ path: string; data: Buffer; }>;
}

export async function buildBlockTints(resources: ResourceManager, textures: TextureLoader): Promise<BuiltBlockTints> {
	const flat: Record<string, string> = { water: PLAINS_WATER };
	const colormaps: Record<string, string> = {};
	const files: Array<{ path: string; data: Buffer; }> = [];
	// dry_foliage only exists in recent versions, so every map is probed rather
	// than assumed — a missing one is a fact about the version, not a failure.
	for (const name of ['grass', 'foliage', 'dry_foliage']) {
		const locator = new ResourceLocator('minecraft', `colormap/${name}`);
		const raw = await resources.getResource('texture', locator);
		if (raw === null) {
			continue;
		}
		const sampled = await sampleColormap(textures, locator, PLAINS_TEMPERATURE, PLAINS_DOWNFALL);
		if (sampled !== null) {
			flat[name] = sampled;
		}
		const file = `colormap/${name}.png`;
		colormaps[name] = file;
		files.push({ path: file, data: raw });
	}

	const blocks: Record<string, Record<string, BlockTint>> = {};
	const put = (id: string, tint: BlockTint, tintindex = 0): void => {
		blocks[`minecraft:${id}`] = { ...blocks[`minecraft:${id}`], [tintindex]: tint };
	};
	for (const id of GRASS_BLOCKS) {
		put(id, { kind: 'grass' });
	}
	for (const id of GRASS_STEM_BLOCKS) {
		put(id, { kind: 'grass' }, 1);
	}
	for (const id of FOLIAGE_BLOCKS) {
		put(id, { kind: 'foliage' });
	}
	for (const id of DRY_FOLIAGE_BLOCKS) {
		put(id, { kind: 'dry_foliage' });
	}
	for (const id of WATER_BLOCKS) {
		put(id, { kind: 'water' });
	}
	/*
	 * Before 1.17 the cauldron *is* the water one — one block with a level, and its
	 * own model is the tinted one. 1.17 split it into empty, water, lava and powder
	 * snow, and from then on the empty one holds nothing to colour. Asked as a
	 * question about the assets rather than about the version, so a snapshot in
	 * between is right for free.
	 */
	if (!(await resources.hasResource('blockstate', ResourceLocator.parse('minecraft:water_cauldron')))) {
		put('cauldron', { kind: 'water' });
	}
	for (const [id, color] of Object.entries(CONSTANT_TINTS)) {
		put(id, { kind: 'constant', color });
	}
	for (const [colour, color] of Object.entries(DYE_TEXTURE_COLORS)) {
		put(`${colour}_banner`, { kind: 'constant', color });
		put(`${colour}_wall_banner`, { kind: 'constant', color });
	}
	put('redstone_wire', { kind: 'ramp', ramp: 'redstone', property: 'power' });
	for (const id of ['melon_stem', 'pumpkin_stem']) {
		put(id, { kind: 'ramp', ramp: 'stem', property: 'age' });
	}

	/*
	 * Only the blocks this version has. The lists above span 1.13 to now, so an
	 * unpruned table tells a 1.18 pack about leaf litter and a modern one about
	 * `grass` under its pre-1.20.3 name — and worse, names a `dry_foliage` tint in a
	 * version that ships no dry-foliage colormap to resolve it against.
	 */
	const present: Record<string, Record<string, BlockTint>> = {};
	for (const [id, tints] of Object.entries(blocks)) {
		if (await resources.hasResource('blockstate', ResourceLocator.parse(id))) {
			present[id] = tints;
		}
	}

	return {
		pack: { flat, colormaps, ramps: { redstone: redstoneRamp(), stem: stemRamp() }, blocks: present },
		files,
	};
}
