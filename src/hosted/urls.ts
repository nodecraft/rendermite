import { itemClassName } from '../output/css-contract.ts';

export const HOSTED_BASE_URL = 'https://assets.rendermite.dev';

export interface IconUrlOptions {
	/** Game version, as listed in `versions.json`. Required for vanilla ids; ignored for modded ones, which are not versioned. */
	version?: string;
	/** `webp` is lossless and animated where the item animates; `png` is a static fallback. */
	format?: 'webp' | 'png';
	/** Defaults to {@link HOSTED_BASE_URL}. */
	baseUrl?: string;
}

export interface StylesheetUrlOptions {
	/** Game version whose vanilla stylesheet to load. */
	version: string;
	/** Mod namespaces to load sheets for; `minecraft` is always included. */
	namespaces?: string[];
	baseUrl?: string;
}

export interface IconClassOptions {
	enchanted?: boolean;
	/** Armour trim material id, e.g. `minecraft:gold`. */
	trim?: string;
	/** Loaded crossbow projectile id, e.g. `minecraft:firework_rocket`. */
	projectile?: string;
}

export interface ItemId {
	namespace: string;
	path: string;
}

/** Splits an item id, defaulting the namespace to `minecraft` like the game does. Case is kept: pre-1.13 mod ids really are CamelCase. */
export function parseItemId(id: string): ItemId {
	const trimmed = id.trim();
	const colon = trimmed.indexOf(':');
	const namespace = colon === -1 ? 'minecraft' : trimmed.slice(0, colon);
	const path = colon === -1 ? trimmed : trimmed.slice(colon + 1);
	if (!namespace || !path) {
		throw new TypeError(`Not an item id: "${id}". Use one like minecraft:diamond_sword or create:wrench.`);
	}
	return { namespace, path };
}

function encodePath(path: string): string {
	return path.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function vanillaRoot(version: string, baseUrl: string): string {
	return `${baseUrl}/icons/${encodeURIComponent(version)}`;
}

/** The URL of one icon. Vanilla and modded icons live under different layouts; this picks the right one. */
export function iconUrl(id: string, options: IconUrlOptions = {}): string {
	const { namespace, path } = parseItemId(id);
	const baseUrl = options.baseUrl ?? HOSTED_BASE_URL;
	const file = `${encodePath(path)}.${options.format ?? 'webp'}`;
	if (namespace !== 'minecraft') {
		return `${baseUrl}/icons/modded/items/${encodeURIComponent(namespace)}/${file}`;
	}
	if (!options.version) {
		throw new TypeError(`Vanilla icons are versioned: pass { version } for ${namespace}:${path}, or resolve one with client.latestVersion().`);
	}
	return `${vanillaRoot(options.version, baseUrl)}/items/minecraft/${file}`;
}

/** The enchant glint texture a version's stylesheet uses. */
export function glintUrl(version: string, baseUrl = HOSTED_BASE_URL): string {
	return `${vanillaRoot(version, baseUrl)}/rc-enchantment.webp`;
}

/**
 * Every stylesheet a page needs, in load order. The vanilla sheet always comes
 * first because mod sheets carry only their item rules, not the base `.rc-item`
 * and glint rules.
 */
export function stylesheetUrls(options: StylesheetUrlOptions): string[] {
	const baseUrl = options.baseUrl ?? HOSTED_BASE_URL;
	const urls = [`${vanillaRoot(options.version, baseUrl)}/rc-minecraft-64.css`];
	for (const namespace of new Set(options.namespaces)) {
		if (namespace !== 'minecraft') {
			urls.push(`${baseUrl}/icons/modded/css/${encodeURIComponent(namespace)}.css`);
		}
	}
	return urls;
}

/** The full class list for a stylesheet icon, e.g. `rc-item rc-minecraft_diamond_sword rc-enchanted`. */
export function iconClass(id: string, options: IconClassOptions = {}): string {
	const classes = ['rc-item', itemClassName(qualify(id))];
	if (options.enchanted) {
		classes.push('rc-enchanted');
	}
	if (options.trim) {
		classes.push(itemClassName(qualify(options.trim), 'rc-trim-'));
	}
	if (options.projectile) {
		classes.push(itemClassName(qualify(options.projectile), 'rc-projectile-'));
	}
	return classes.join(' ');
}

/** `diamond_sword` → `minecraft:diamond_sword`. */
export function qualify(id: string): string {
	const { namespace, path } = parseItemId(id);
	return `${namespace}:${path}`;
}
