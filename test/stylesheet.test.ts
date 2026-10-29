import { describe, expect, it } from 'vitest';

import { generateStylesheet, itemClass } from '../src/output/stylesheet.ts';

describe('itemClass', () => {
	it('maps colon to underscore', () => {
		expect(itemClass('minecraft:stone')).toBe('rc-minecraft_stone');
	});

	it('sanitizes hostile characters', () => {
		expect(itemClass('dannys_expansion:ho;ly_wreath')).toBe('rc-dannys_expansion_ho_ly_wreath');
		// Hyphens are within the consumer's allowed [\w.-] set; spaces are not.
		expect(itemClass('academy:shiny_fossil - Copy')).toBe('rc-academy_shiny_fossil_-_Copy');
	});

	it('escapes dots so versioned ids stay one class', () => {
		expect(itemClass('cobblemon:quests_v1.1.12')).toBe(String.raw`rc-cobblemon_quests_v1\.1\.12`);
	});
});

describe('generateStylesheet', () => {
	const sheet = generateStylesheet([
		{ id: 'minecraft:stone', image: 'items/minecraft/stone' },
		{
			id: 'minecraft:leather_chestplate',
			image: 'items/_leather_armor/leather_chestplate_base',
			mask: 'items/minecraft/leather_chestplate',
			variables: { '--rc-layer-1-tint': '#9e643f' },
			before: { image: 'items/_leather_armor/leather_chestplate_overlay', mask: 'items/_leather_armor/leather_chestplate_overlay' },
			variants: [{
				suffix: 'trim-minecraft_quartz',
				before: { image: 'items/_leather_armor/leather_chestplate_quartz_trim' },
			}],
		},
		{ id: 'minecraft:enchanted_book', image: 'items/minecraft/enchanted_book', alwaysEnchanted: true },
	]);

	it('emits the contract base rules', () => {
		expect(sheet).toContain('@keyframes rc-enchanted');
		expect(sheet).toContain('.rc-item {');
		expect(sheet).toContain('background-color: var(--rc-layer-1-tint);');
		expect(sheet).toContain('background-blend-mode: multiply;');
	});

	it('emits per-item rules with mask clearing and enchant variants', () => {
		expect(sheet).toContain('.rc-item.rc-minecraft_stone {\n    background-image: url(\'items/minecraft/stone.png\');\n    mask-image: none;\n}');
		expect(sheet).toContain('.rc-item.rc-minecraft_stone.rc-enchanted {\n    mask-image: url(\'items/minecraft/stone.png\');\n}');
	});

	it('emits tinted layered items with variables and trim variants', () => {
		expect(sheet).toContain('--rc-layer-1-tint: #9e643f;');
		expect(sheet).toContain('.rc-item.rc-minecraft_leather_chestplate:before');
		expect(sheet).toContain('.rc-item.rc-minecraft_leather_chestplate.rc-trim-minecraft_quartz:before');
	});

	it('unions always-enchanted items into the glint selector list', () => {
		expect(sheet).toContain('.rc-item.rc-minecraft_enchanted_book:after,\n.rc-enchanted:after {');
		expect(sheet).toContain('mix-blend-mode: screen;');
		expect(sheet).toContain('animation-duration: 32s;');
	});

	it('leaves the glint filter to the baked texture instead of running it every frame', () => {
		expect(sheet).not.toContain('filter:');
	});

	it('caps glint repaints at 15 a second whatever the display refresh rate', () => {
		// 480 steps over the 32s loop is one repaint every 67ms.
		expect(sheet).toContain('animation-duration: 32s;\n    animation-timing-function: steps(480);');
	});

	it('clips glinting items so the oversized glint adds no scrollable overflow', () => {
		expect(sheet).toContain('.rc-item.rc-minecraft_enchanted_book,\n.rc-enchanted {\n    overflow: hidden;\n}');
	});

	it('emits the webp upgrade block behind the resolution media query', () => {
		expect(sheet).toContain('@media (min-resolution: 1dpi)');
		expect(sheet).toContain('background-image: url(\'items/minecraft/stone.webp\');');
	});

	it('prefixes urls when configured', () => {
		const prefixed = generateStylesheet([{ id: 'a:b', image: 'items/a/b' }], { urlPrefix: '../' });
		expect(prefixed).toContain('url(\'../items/a/b.png\')');
	});
});
