/**
 * Hard-coded tint tables for eras before item definitions (pre-1.21.4), ported
 * from renderchest v2.5.2's TinterManager. Keyed by model path in the parent
 * chain (upstream bound a tinter per model as each chain entry loaded, so the
 * deepest matching entry wins). Colormap-driven tints sample the map center
 * (0.5, 0.5), matching the era's renderer.
 */

import { ResourceLocator } from '../resources/locator.ts';

import type { TintColor } from './face.ts';
import type { TextureLoader } from '../textures/loader.ts';

const FOLIAGE_MODELS = new Set([
	'block/oak_leaves',
	'block/birch_leaves',
	'block/acacia_leaves',
	'block/jungle_leaves',
	'block/spruce_leaves',
	'block/dark_oak_leaves',
	'block/mangrove_leaves',
	'item/lily_pad',
	'item/grass',
	'item/short_grass',
	'item/tall_grass',
	'item/fern',
	'item/large_fern',
	'item/vine',
]);

/** Spawn eggs: [base, spots]; banners/potions single layer. Verbatim from v2.5.2. */
const FIXED_COLORS: Record<string, string[]> = {
	'item/potion': ['#375cc4'],
	'item/splash_potion': ['#375cc4'],
	'item/lingering_potion': ['#375cc4'],
	'item/allay_spawn_egg': ['#00d7fc', '#00abfc'],
	'item/armadillo_spawn_egg': ['#a67775', '#734b4f'],
	'item/axolotl_spawn_egg': ['#f8bfe0', '#a42c73'],
	'item/bat_spawn_egg': ['#4b3d2f', '#0f0f0f'],
	'item/bee_spawn_egg': ['#eac142', '#42241b'],
	'item/blaze_spawn_egg': ['#f3b001', '#fcf57d'],
	'item/breeze_spawn_egg': ['#af94df', '#9166df'],
	'item/cat_spawn_egg': ['#ecc68c', '#937155'],
	'item/cave_spider_spawn_egg': ['#0c414d', '#a60e0e'],
	'item/chicken_spawn_egg': ['#9f9f9f', '#fc0000'],
	'item/cod_spawn_egg': ['#bfa569', '#e2c289'],
	'item/cow_spawn_egg': ['#433526', '#9f9f9f'],
	'item/creeper_spawn_egg': ['#0da50b', '#000000'],
	'item/dolphin_spawn_egg': ['#223a4c', '#f6f6f6'],
	'item/donkey_spawn_egg': ['#524438', '#847465'],
	'item/drowned_spawn_egg': ['#8deed4', '#789a64'],
	'item/elder_guardian_spawn_egg': ['#cccab8', '#737591'],
	'item/enderman_spawn_egg': ['#161616', '#000000'],
	'item/endermite_spawn_egg': ['#161616', '#6d6d6d'],
	'item/evoker_spawn_egg': ['#939999', '#1e1c1a'],
	'item/fox_spawn_egg': ['#d2b49d', '#ca6820'],
	'item/frog_spawn_egg': ['#ce7343', '#fcc57b'],
	'item/ghast_spawn_egg': ['#f6f6f6', '#bababa'],
	'item/glow_squid_spawn_egg': ['#095555', '#83eeba'],
	'item/goat_spawn_egg': ['#a3927b', '#54483d'],
	'item/guardian_spawn_egg': ['#598071', '#ee7c2f'],
	'item/hoglin_spawn_egg': ['#c46d54', '#5e6363'],
	'item/horse_spawn_egg': ['#be9c7c', '#ebe200'],
	'item/husk_spawn_egg': ['#786f60', '#e3ca92'],
	'item/llama_spawn_egg': ['#be9c7c', '#975e3f'],
	'item/magma_cube_spawn_egg': ['#330000', '#f9f900'],
	'item/mooshroom_spawn_egg': ['#9e0f10', '#b5b5b5'],
	'item/mule_spawn_egg': ['#1b0200', '#50321d'],
	'item/ocelot_spawn_egg': ['#ecdb7c', '#554333'],
	'item/panda_spawn_egg': ['#e4e4e4', '#1b1b22'],
	'item/parrot_spawn_egg': ['#0da50b', '#fc0000'],
	'item/phantom_spawn_egg': ['#425088', '#86fc00'],
	'item/pig_spawn_egg': ['#eda3a0', '#d8625e'],
	'item/piglin_spawn_egg': ['#975e3f', '#f6f0a2'],
	'item/piglin_brute_spawn_egg': ['#582910', '#f6f0a2'],
	'item/pillager_spawn_egg': ['#522e35', '#939999'],
	'item/polar_bear_spawn_egg': ['#efefef', '#93938e'],
	'item/pufferfish_spawn_egg': ['#f3b001', '#36c1ef'],
	'item/rabbit_spawn_egg': ['#975e3f', '#724730'],
	'item/ravager_spawn_egg': ['#74736f', '#5a4f48'],
	'item/salmon_spawn_egg': ['#9e0f10', '#0e8273'],
	'item/sheep_spawn_egg': ['#e4e4e4', '#fcb3b3'],
	'item/shulker_spawn_egg': ['#926692', '#4c3751'],
	'item/silverfish_spawn_egg': ['#6d6d6d', '#2f2f2f'],
	'item/skeleton_spawn_egg': ['#bfbfbf', '#484848'],
	'item/skeleton_horse_spawn_egg': ['#67674e', '#e2e2d5'],
	'item/slime_spawn_egg': ['#509e3d', '#7dbd6d'],
	'item/spider_spawn_egg': ['#332c27', '#a60e0e'],
	'item/squid_spawn_egg': ['#223a4c', '#6f8697'],
	'item/stray_spawn_egg': ['#607576', '#dae7e7'],
	'item/strider_spawn_egg': ['#9a3335', '#4c484c'],
	'item/tadpole_spawn_egg': ['#6c523c', '#160a00'],
	'item/trader_llama_spawn_egg': ['#e7a22f', '#446194'],
	'item/tropical_fish_spawn_egg': ['#ec6815', '#fcf6ec'],
	'item/turtle_spawn_egg': ['#e4e4e4', '#00adad'],
	'item/vex_spawn_egg': ['#798ea2', '#e5eaee'],
	'item/villager_spawn_egg': ['#553b32', '#bb8971'],
	'item/vindicator_spawn_egg': ['#939999', '#275d60'],
	'item/wandering_trader_spawn_egg': ['#446194', '#e7a22f'],
	'item/warden_spawn_egg': ['#0f4548', '#38d3dd'],
	'item/witch_spawn_egg': ['#330000', '#509e3d'],
	'item/wither_skeleton_spawn_egg': ['#141414', '#464c4c'],
	'item/wolf_spawn_egg': ['#d4d0d0', '#ccad94'],
	'item/zoglin_spawn_egg': ['#c46d54', '#e3e3e3'],
	'item/zombie_spawn_egg': ['#00adad', '#789a64'],
	'item/zombie_horse_spawn_egg': ['#305133', '#95c082'],
	'item/zombie_villager_spawn_egg': ['#553b32', '#789a64'],
	'item/zombified_piglin_spawn_egg': ['#e79191', '#4b7028'],
	'item/camel_spawn_egg': ['#f9c168', '#c99136'],
	'item/ender_dragon_spawn_egg': ['#1c1c1c', '#dd78f7'],
	'item/wither_spawn_egg': ['#141414', '#4c719e'],
	'item/snow_golem_spawn_egg': ['#d6efef', '#7fa2a2'],
	'item/iron_golem_spawn_egg': ['#d8cbc0', '#73a131'],
	'item/sniffer_spawn_egg': ['#871e09', '#25ab70'],
	// Pre-1.13 single banner item defaults to white, like the modern white_banner.
	'item/banner': ['#f6fcfb'],
	'item/white_banner': ['#f6fcfb'],
	'item/orange_banner': ['#f67e1d'],
	'item/magenta_banner': ['#c54dbb'],
	'item/light_blue_banner': ['#39b1d7'],
	'item/yellow_banner': ['#fbd53c'],
	'item/lime_banner': ['#7ec51f'],
	'item/pink_banner': ['#f089a8'],
	'item/gray_banner': ['#464e51'],
	'item/light_gray_banner': ['#9b9b95'],
	'item/cyan_banner': ['#169a9a'],
	'item/purple_banner': ['#8731b6'],
	'item/blue_banner': ['#3b43a8'],
	'item/brown_banner': ['#815331'],
	'item/green_banner': ['#5d7b16'],
	'item/red_banner': ['#ae2d26'],
	'item/black_banner': ['#1d1d21'],
};

function hexTint(hex: string): TintColor {
	return {
		r: Number.parseInt(hex.slice(1, 3), 16) / 255,
		g: Number.parseInt(hex.slice(3, 5), 16) / 255,
		b: Number.parseInt(hex.slice(5, 7), 16) / 255,
	};
}

/** Sample a colormap; both axes clamped, out-of-map falls back to magenta. */
async function sampleCenter(textures: TextureLoader, map: string): Promise<TintColor> {
	const texture = await textures.load(ResourceLocator.parse(map));
	if (!texture) {
		return { r: 1, g: 0, b: 1 };
	}
	const x = Math.min(texture.width - 1, Math.floor(0.5 * texture.width));
	const y = Math.min(texture.height - 1, Math.floor(0.5 * texture.height));
	const offset = (y * texture.width + x) * 4;
	return {
		r: texture.data[offset] / 255,
		g: texture.data[offset + 1] / 255,
		b: texture.data[offset + 2] / 255,
	};
}

/**
 * Tints for a model rendered without an item definition (pre-1.21.4 eras and
 * modded models/item trees). Walks the resolved chain deepest-first, so an
 * item model beats the block model it parents, matching upstream's per-model
 * binding. Returns null when nothing in the chain is tinted.
 */
export async function legacyTintsForChain(
	chain: string[],
	textures: TextureLoader,
): Promise<Array<TintColor | null> | null> {
	for (const entry of chain) {
		const locator = ResourceLocator.tryParse(entry);
		if (!locator || locator.namespace !== 'minecraft') {
			continue;
		}
		const fixed = FIXED_COLORS[locator.path];
		if (fixed) {
			return fixed.map(color => hexTint(color));
		}
		if (FOLIAGE_MODELS.has(locator.path)) {
			return [await sampleCenter(textures, 'minecraft:colormap/foliage')];
		}
		if (locator.path === 'block/grass_block') {
			return [await sampleCenter(textures, 'minecraft:colormap/grass')];
		}
	}
	return null;
}
