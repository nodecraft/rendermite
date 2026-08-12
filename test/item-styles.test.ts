import { describe, expect, it } from 'vitest';

import { classifyItemStyle } from '../src/output/item-styles.ts';
import { generateStylesheet } from '../src/output/stylesheet.ts';

const rendered = new Set([
	'minecraft:stone',
	'minecraft:decorated_pot',
	'minecraft:diamond_chestplate',
	'minecraft:leather_boots',
	'minecraft:golden_helmet',
	'minecraft:potion',
	'minecraft:crossbow',
	'minecraft:filled_map',
	'minecraft:enchanted_book',
	'minecraft:rc_potion_content',
	'minecraft:rc_potion_bottle',
	'minecraft:rc_filled_map_base',
	'minecraft:rc_filled_map_overlay',
	'_decorated_pot:pot_b_brick',
	'_decorated_pot:pot_o_brick',
	'_armor_trims:chestplate_trim_quartz',
	'_armor_trims:chestplate_trim_diamond_darker',
	'_armor_trims:helmet_trim_gold_darker',
	'_leather_armor:leather_boots_base',
	'_leather_armor:leather_boots_overlay',
	'_leather_armor:leather_boots_quartz_trim',
	'_crossbow:arrow',
	'_crossbow:rocket',
]);

describe('classifyItemStyle', () => {
	it('suppresses internal rc_ layer sources', () => {
		expect(classifyItemStyle('minecraft:rc_potion_content', rendered)).toBeNull();
	});

	it('plain items get a plain style', () => {
		const style = classifyItemStyle('minecraft:stone', rendered);
		expect(style).toEqual({ id: 'minecraft:stone', image: 'items/minecraft/stone' });
	});

	it('decorated pot gets body and overlay sherd variants', () => {
		const style = classifyItemStyle('minecraft:decorated_pot', rendered);
		expect(style?.variants).toContainEqual({ suffix: 'pot-1-minecraft_brick', image: 'items/_decorated_pot/pot_b_brick' });
		expect(style?.variants).toContainEqual({ suffix: 'pot-2-minecraft_brick', before: { image: 'items/_decorated_pot/pot_o_brick' } });
		// Sherds without rendered images emit no variant.
		expect(style?.variants?.some(variant => variant.suffix.includes('angler'))).toBe(false);
	});

	it('non-leather armor gets trim variants, darker when trim matches the metal', () => {
		const style = classifyItemStyle('minecraft:diamond_chestplate', rendered);
		expect(style?.mask).toBe('items/minecraft/diamond_chestplate');
		expect(style?.variants).toContainEqual({
			suffix: 'trim-minecraft_quartz',
			before: { image: 'items/_armor_trims/chestplate_trim_quartz', mask: 'items/_armor_trims/chestplate_trim_quartz' },
		});
		expect(style?.variants).toContainEqual({
			suffix: 'trim-minecraft_diamond',
			before: { image: 'items/_armor_trims/chestplate_trim_diamond_darker', mask: 'items/_armor_trims/chestplate_trim_diamond_darker' },
		});
	});

	it('golden armor maps to the gold darker palette', () => {
		const style = classifyItemStyle('minecraft:golden_helmet', rendered);
		expect(style?.variants).toContainEqual({
			suffix: 'trim-minecraft_gold',
			before: { image: 'items/_armor_trims/helmet_trim_gold_darker', mask: 'items/_armor_trims/helmet_trim_gold_darker' },
		});
	});

	it('leather armor layers base + overlay with the default tint', () => {
		const style = classifyItemStyle('minecraft:leather_boots', rendered);
		expect(style?.image).toBe('items/_leather_armor/leather_boots_base');
		expect(style?.mask).toBe('items/minecraft/leather_boots');
		expect(style?.variables).toEqual({ '--rc-layer-1-tint': '#9e643f' });
		expect(style?.before?.image).toBe('items/_leather_armor/leather_boots_overlay');
		expect(style?.variants).toContainEqual({
			suffix: 'trim-minecraft_quartz',
			before: { image: 'items/_leather_armor/leather_boots_quartz_trim', mask: 'items/_leather_armor/leather_boots_quartz_trim' },
		});
	});

	it('potions layer content under the bottle with the default tint', () => {
		const style = classifyItemStyle('minecraft:potion', rendered);
		expect(style?.image).toBe('items/minecraft/rc_potion_content');
		expect(style?.mask).toBe('items/minecraft/potion');
		expect(style?.variables).toEqual({ '--rc-layer-1-tint': '#f800f8' });
		expect(style?.before?.image).toBe('items/minecraft/rc_potion_bottle');
	});

	it('crossbow projectile variants restyle the base element', () => {
		const style = classifyItemStyle('minecraft:crossbow', rendered);
		expect(style?.variants).toContainEqual({ suffix: 'projectile-minecraft_arrow', image: 'items/_crossbow/arrow' });
		expect(style?.variants).toContainEqual({ suffix: 'projectile-minecraft_firework_rocket', image: 'items/_crossbow/rocket' });
	});

	it('filled map layers with the map tint variable', () => {
		const style = classifyItemStyle('minecraft:filled_map', rendered);
		expect(style?.variables).toEqual({ '--rc-layer-2-tint': '#46402e' });
		expect(style?.before?.image).toBe('items/minecraft/rc_filled_map_overlay');
	});

	it('always-enchanted items are flagged', () => {
		expect(classifyItemStyle('minecraft:enchanted_book', rendered)?.alwaysEnchanted).toBe(true);
	});
});

describe('generateStylesheet with classified styles', () => {
	it('emits pot and projectile variant rules with enchant masks', () => {
		const styles = ['minecraft:decorated_pot', 'minecraft:crossbow']
			.map(id => classifyItemStyle(id, rendered))
			.filter(style => style !== null);
		const sheet = generateStylesheet(styles);
		expect(sheet).toContain('.rc-item.rc-minecraft_decorated_pot.rc-pot-1-minecraft_brick {\n    background-image: url(\'items/_decorated_pot/pot_b_brick.png\');\n}');
		expect(sheet).toContain('.rc-item.rc-minecraft_decorated_pot.rc-pot-2-minecraft_brick:before');
		expect(sheet).toContain('.rc-item.rc-minecraft_crossbow.rc-projectile-minecraft_arrow {\n    background-image: url(\'items/_crossbow/arrow.png\');\n}');
		expect(sheet).toContain('.rc-item.rc-minecraft_crossbow.rc-projectile-minecraft_arrow.rc-enchanted');
	});
});
