/**
 * Per-item CSS style classification, ported from upstream's ItemStyleGenerators
 * (Internal, DecoratedPot, Armor, Potion, ChargedProjectile, Map, FireWorkStar,
 * Enchanted, Default — first match wins). Variant rules only reference dynamic
 * images that actually rendered, so a version without (say) resin trims never
 * emits rules pointing at missing files.
 */

import {
	ARMOR_ITEM_TYPES,
	POTTERY_SHERDS,
	TRIM_DARKER_MATERIALS,
	TRIM_MATERIALS,
} from '../dynamic/generators.ts';

import type { ItemStyle } from './stylesheet.ts';

const ARMOR_MATERIALS = ['leather', 'copper', 'chainmail', 'iron', 'golden', 'diamond', 'netherite'] as const;

/** Items that always show the enchant glint. */
const ENCHANTED_EFFECT_ITEMS = new Set([
	'minecraft:experience_bottle',
	'minecraft:enchanted_golden_apple',
	'minecraft:enchanted_book',
	'minecraft:written_book',
]);

const POTIONS: Record<string, { content: string; bottle: string; }> = {
	'minecraft:potion': { content: 'rc_potion_content', bottle: 'rc_potion_bottle' },
	'minecraft:splash_potion': { content: 'rc_potion_content', bottle: 'rc_potion_bottle_splash' },
	'minecraft:lingering_potion': { content: 'rc_potion_content', bottle: 'rc_potion_bottle_lingering' },
	'minecraft:tipped_arrow': { content: 'rc_tipped_arrow_head', bottle: 'rc_tipped_arrow_base' },
};

function image(id: string): string {
	return `items/${id.replace(':', '/')}`;
}

/**
 * Build the ItemStyle for a rendered item. `renderedIds` gates variant rules to
 * images that exist. Returns null for internal layer-source items (rc_*),
 * which get no rules of their own.
 */
export function classifyItemStyle(id: string, renderedIds: ReadonlySet<string>): ItemStyle | null {
	const [namespace, name] = id.split(':', 2);
	if (namespace === 'minecraft' && name.startsWith('rc_')) {
		return null;
	}
	const base: ItemStyle = { id, image: image(id) };

	if (id === 'minecraft:decorated_pot') {
		base.variants = [];
		for (const sherd of POTTERY_SHERDS) {
			if (renderedIds.has(`_decorated_pot:pot_b_${sherd}`)) {
				base.variants.push({ suffix: `pot-1-minecraft_${sherd}`, image: image(`_decorated_pot:pot_b_${sherd}`) });
			}
			if (renderedIds.has(`_decorated_pot:pot_o_${sherd}`)) {
				base.variants.push({ suffix: `pot-2-minecraft_${sherd}`, before: { image: image(`_decorated_pot:pot_o_${sherd}`) } });
			}
		}
		return base;
	}

	const armor = parseArmor(id);
	if (armor) {
		base.variants = [];
		if (armor.material === 'leather') {
			const layerBase = `_leather_armor:leather_${armor.type}_base`;
			if (renderedIds.has(layerBase)) {
				base.image = image(layerBase);
				base.mask = image(id);
				base.variables = { '--rc-layer-1-tint': '#9e643f' };
				if (renderedIds.has(`_leather_armor:leather_${armor.type}_overlay`)) {
					const overlay = image(`_leather_armor:leather_${armor.type}_overlay`);
					base.before = { image: overlay, mask: overlay };
				}
			}
			for (const material of TRIM_MATERIALS) {
				const trim = `_leather_armor:leather_${armor.type}_${material}_trim`;
				if (renderedIds.has(trim)) {
					base.variants.push({
						suffix: `trim-minecraft_${material}`,
						before: { image: image(trim), mask: image(trim) },
					});
				}
			}
			return base;
		}
		base.mask = image(id);
		for (const material of TRIM_MATERIALS) {
			// The darker palette applies when the trim matches the armor's own
			// metal (golden armor uses the gold trim palette).
			const armorMetal = armor.material === 'golden' ? 'gold' : armor.material;
			const variant = material === armorMetal && TRIM_DARKER_MATERIALS.has(material)
				? `${material}_darker`
				: material;
			const trim = `_armor_trims:${armor.type}_trim_${variant}`;
			if (renderedIds.has(trim)) {
				base.variants.push({
					suffix: `trim-minecraft_${material}`,
					before: { image: image(trim), mask: image(trim) },
				});
			}
		}
		return base;
	}

	const potion = POTIONS[id];
	if (potion && renderedIds.has(`minecraft:${potion.content}`)) {
		base.image = image(`minecraft:${potion.content}`);
		base.mask = image(id);
		base.variables = { '--rc-layer-1-tint': '#f800f8' };
		if (renderedIds.has(`minecraft:${potion.bottle}`)) {
			const bottle = image(`minecraft:${potion.bottle}`);
			base.before = { image: bottle, mask: bottle };
		}
		return base;
	}

	if (id === 'minecraft:crossbow') {
		base.variants = [];
		const projectiles: Array<[projectile: string, source: string]> = [
			['arrow', '_crossbow:arrow'],
			['spectral_arrow', '_crossbow:arrow'],
			['tipped_arrow', '_crossbow:arrow'],
			['firework_rocket', '_crossbow:rocket'],
		];
		for (const [projectile, source] of projectiles) {
			if (renderedIds.has(source)) {
				base.variants.push({ suffix: `projectile-minecraft_${projectile}`, image: image(source) });
			}
		}
		return base;
	}

	if (id === 'minecraft:filled_map' && renderedIds.has('minecraft:rc_filled_map_base')) {
		base.image = image('minecraft:rc_filled_map_base');
		base.mask = image(id);
		base.variables = { '--rc-layer-2-tint': '#46402e' };
		if (renderedIds.has('minecraft:rc_filled_map_overlay')) {
			base.before = { image: image('minecraft:rc_filled_map_overlay') };
		}
		return base;
	}

	if (id === 'minecraft:firework_star' && renderedIds.has('minecraft:rc_firework_star_base')) {
		base.image = image('minecraft:rc_firework_star_base');
		base.mask = image(id);
		base.variables = { '--rc-layer-2-tint': '#8a8a8a' };
		if (renderedIds.has('minecraft:rc_firework_star_overlay')) {
			base.before = { image: image('minecraft:rc_firework_star_overlay') };
		}
		return base;
	}

	if (ENCHANTED_EFFECT_ITEMS.has(id)) {
		base.alwaysEnchanted = true;
	}
	return base;
}

function parseArmor(id: string): { material: string; type: string; } | null {
	if (!id.startsWith('minecraft:')) {
		return null;
	}
	const name = id.slice('minecraft:'.length);
	for (const material of ARMOR_MATERIALS) {
		if (!name.startsWith(`${material}_`)) {
			continue;
		}
		const type = name.slice(material.length + 1);
		if ((ARMOR_ITEM_TYPES as readonly string[]).includes(type)) {
			return { material, type };
		}
	}
	return null;
}
