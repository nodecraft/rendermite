/**
 * Dynamic resources ported from renderchest's DynamicResourceGenerators, built
 * as plain model/item layers instead of code-backed namespaces: decorated pot
 * variants, leather armor trim layers, armor trim sprites (resolved by the
 * paletted_permutations atlas), and charged crossbows. The synthetic namespace
 * names (underscore prefix) match upstream so the CSS contract stays stable.
 */

import { ResourceLocator } from '../resources/locator.ts';
import { MapResourceManager } from '../resources/synthetic.ts';

import type { ResourceManager } from '../resources/manager.ts';

export const TRIM_MATERIALS = [
	'quartz',
	'iron',
	'gold',
	'diamond',
	'netherite',
	'redstone',
	'copper',
	'emerald',
	'lapis',
	'amethyst',
	'resin',
] as const;

/** Materials with a darker variant used when the trim matches the armor metal. */
export const TRIM_DARKER_MATERIALS = new Set(['copper', 'iron', 'gold', 'diamond', 'netherite']);

export const ARMOR_ITEM_TYPES = ['boots', 'leggings', 'chestplate', 'helmet'] as const;

export const POTTERY_SHERDS = [
	'brick',
	'angler',
	'archer',
	'arms_up',
	'blade',
	'brewer',
	'burn',
	'danger',
	'explorer',
	'friend',
	'heart',
	'heartbreak',
	'howl',
	'miner',
	'mourner',
	'plenty',
	'prize',
	'sheaf',
	'shelter',
	'skull',
	'snort',
	'flow',
	'guster',
	'scrape',
] as const;

function sherdTextureName(sherd: string): string {
	return sherd === 'brick' ? 'brick' : `${sherd}_pottery_sherd`;
}

/**
 * Whether the version has armor trims, judged by the trim palette key: 26.3 moved it from
 * textures/trims/color_palettes/trim_palette to textures/palettes/trim_base.
 */
export async function hasArmorTrims(resources: ResourceManager): Promise<boolean> {
	return await resources.hasResource('texture', ResourceLocator.parse('minecraft:trims/color_palettes/trim_palette'))
		|| await resources.hasResource('texture', ResourceLocator.parse('minecraft:palettes/trim_base'));
}

export interface DynamicItem {
	/** Item id including the synthetic namespace, e.g. `_armor_trims:helmet_trim_gold`. */
	id: string;
}

export interface DynamicResources {
	layer: MapResourceManager;
	items: DynamicItem[];
}

/**
 * Materials whose trim sprites exist for the target version are discovered by
 * the caller (via the atlas resolver); this generates the full matrix and lets
 * missing sprites fail per item.
 */
export function builtinDynamicResources(): DynamicResources {
	const layer = new MapResourceManager();
	const items: DynamicItem[] = [];

	// _armor_trims: flat trim overlay sprites (paletted_permutations output).
	for (const type of ARMOR_ITEM_TYPES) {
		for (const material of TRIM_MATERIALS) {
			const variants = TRIM_DARKER_MATERIALS.has(material)
				? [material, `${material}_darker`]
				: [material];
			for (const variant of variants) {
				const name = `${type}_trim_${variant}`;
				layer.set('model', `_armor_trims:item/${name}`, JSON.stringify({
					parent: 'minecraft:item/generated',
					textures: { layer0: `minecraft:trims/items/${type}_trim_${variant}` },
				}));
				layer.set('itemDefinition', `_armor_trims:${name}`, JSON.stringify({
					model: { type: 'minecraft:model', model: `_armor_trims:item/${name}` },
				}));
				items.push({ id: `_armor_trims:${name}` });
			}
		}
	}

	// _leather_armor: base sprite, overlay sprite, and overlay+trim layers.
	for (const type of ARMOR_ITEM_TYPES) {
		const entries: Array<[name: string, textures: Record<string, string>]> = [
			[`leather_${type}_base`, { layer0: `minecraft:item/leather_${type}` }],
			[`leather_${type}_overlay`, { layer0: `minecraft:item/leather_${type}_overlay` }],
		];
		for (const material of TRIM_MATERIALS) {
			entries.push([`leather_${type}_${material}_trim`, {
				layer0: `minecraft:item/leather_${type}_overlay`,
				layer1: `minecraft:trims/items/${type}_trim_${material}`,
			}]);
		}
		for (const [name, textures] of entries) {
			layer.set('model', `_leather_armor:item/${name}`, JSON.stringify({
				parent: 'minecraft:item/generated',
				textures,
			}));
			layer.set('itemDefinition', `_leather_armor:${name}`, JSON.stringify({
				model: { type: 'minecraft:model', model: `_leather_armor:item/${name}` },
			}));
			items.push({ id: `_leather_armor:${name}` });
		}
	}

	// _decorated_pot: the pot body with a sherd on the visible west face, and a
	// flat overlay plane per sherd. Texture names resolve through the builtin
	// decorated_pot_base declarations.
	for (const sherd of POTTERY_SHERDS) {
		const texture = sherdTextureName(sherd);
		layer.set('model', `_decorated_pot:pot_b_${sherd}`, JSON.stringify({
			parent: 'renderchest:item/decorated_pot',
			textures: {
				north: '#brick',
				south: '#brick',
				east: '#brick',
				west: `#${texture}`,
			},
		}));
		layer.set('itemDefinition', `_decorated_pot:pot_b_${sherd}`, JSON.stringify({
			model: { type: 'minecraft:model', model: `_decorated_pot:pot_b_${sherd}` },
		}));
		items.push({ id: `_decorated_pot:pot_b_${sherd}` });

		layer.set('model', `_decorated_pot:pot_o_${sherd}`, JSON.stringify({
			parent: 'renderchest:item/decorated_pot_overlay',
			textures: { south: `#${texture}` },
		}));
		layer.set('itemDefinition', `_decorated_pot:pot_o_${sherd}`, JSON.stringify({
			model: { type: 'minecraft:model', model: `_decorated_pot:pot_o_${sherd}` },
		}));
		items.push({ id: `_decorated_pot:pot_o_${sherd}` });
	}

	// _crossbow: the charged variants, pointing straight at the vanilla models
	// the crossbow definition would select for each charge type.
	for (const [name, model] of [['arrow', 'minecraft:item/crossbow_arrow'], ['rocket', 'minecraft:item/crossbow_firework']] as const) {
		layer.set('itemDefinition', `_crossbow:${name}`, JSON.stringify({
			model: { type: 'minecraft:model', model },
		}));
		items.push({ id: `_crossbow:${name}` });
	}

	return { layer, items };
}
