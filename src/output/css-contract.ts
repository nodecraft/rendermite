/**
 * The parts of the stylesheet's class contract that markup has to agree with.
 * Kept free of imports so the browser-safe hosted entry can share them with the
 * generator instead of carrying a copy that drifts.
 */

/** Items the game always draws with the enchant glint, enchanted or not. */
export const ENCHANTED_EFFECT_ITEMS: ReadonlySet<string> = new Set([
	'minecraft:experience_bottle',
	'minecraft:enchanted_golden_apple',
	'minecraft:enchanted_book',
	'minecraft:written_book',
]);

/** The class name for an item id, as written in markup (unescaped). Ids come from mod jars, so anything outside `[\w.-]` is replaced. */
export function itemClassName(id: string, prefix = 'rc-'): string {
	return prefix + id.replaceAll(':', '_').replaceAll(/[^\w.-]/g, '_');
}
