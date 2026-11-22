/**
 * Helpers for the free hosted icons on `assets.rendermite.dev`, for pages and
 * services that use the published renders rather than making their own.
 *
 * Like `/pack`, this entry is browser-safe: no `node:` builtin, no dependency,
 * nothing from the renderer. `test/hosted-entry.test.ts` holds it to that.
 *
 * @example
 * ```ts
 * import { createHostedClient, defineItemElement, iconUrl } from '@nodecraft/rendermite/hosted';
 *
 * iconUrl('minecraft:diamond_sword', { version: '1.21.8' });
 * iconUrl('create:wrench');
 *
 * const hosted = createHostedClient();
 * const wool = await hosted.item('minecraft:wool', { version: '1.12.2', damage: 1 });
 *
 * defineItemElement(); // <mc-item item="create:wrench" enchanted></mc-item>
 * ```
 */

export { createHostedClient } from './hosted/client.ts';
export { defineItemElement } from './hosted/element.ts';
export { glintUrl, HOSTED_BASE_URL, iconClass, iconUrl, parseItemId, stylesheetUrls } from './hosted/urls.ts';
export type {
	HostedClient,
	HostedClientOptions,
	HostedEnchantment,
	HostedFailure,
	HostedItem,
	HostedItemRegistry,
	HostedItemVariant,
	HostedRegistryItem,
	ItemLookupOptions,
} from './hosted/client.ts';
export type { ItemElementOptions } from './hosted/element.ts';
export type { IconClassOptions, IconUrlOptions, ItemId, StylesheetUrlOptions } from './hosted/urls.ts';
