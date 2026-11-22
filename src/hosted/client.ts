import {
	HOSTED_BASE_URL,
	iconClass,
	iconUrl,
	parseItemId,
} from './urls.ts';

/** A pre-1.13 damage value that draws as its own item, e.g. `minecraft:wool` damage 1 is Orange Wool. */
export interface HostedItemVariant {
	damage: number;
	displayName: string;
	iconId: string;
}

export interface HostedRegistryItem {
	id: string;
	displayName: string;
	stackSize: number;
	/** Pre-1.13 numeric id. */
	numericId?: number;
	/** Set when the icon is published under another name, e.g. `minecraft:deadbush` draws as `dead_bush`. */
	iconId?: string;
	variants?: HostedItemVariant[];
}

export interface HostedEnchantment {
	id: string;
	displayName: string;
	maxLevel: number;
}

/** `items-<version>.json`. */
export interface HostedItemRegistry {
	version: string;
	enchantments: HostedEnchantment[];
	items: HostedRegistryItem[];
}

/** One entry of `rc-minecraft-failures.json`. */
export interface HostedFailure {
	id: string;
	error: string;
}

export interface HostedItem {
	/** The id asked for, with its namespace. */
	id: string;
	url: string;
	/** Class list for the hosted stylesheet. */
	className: string;
	/** Vanilla only: modded icons are not versioned. */
	version?: string;
	/** Vanilla only: the registry has no modded entries. */
	displayName?: string;
	stackSize?: number;
	/** Why the icon did not render, when the version publishes a failures file that lists it. */
	failure?: string;
}

export interface ItemLookupOptions {
	/** Defaults to the latest published version. Ignored for modded ids. */
	version?: string;
	/** Pre-1.13 damage value, for items whose variants draw differently. Defaults to 0. */
	damage?: number;
}

export interface HostedClientOptions {
	baseUrl?: string;
	/** Defaults to the global `fetch`. */
	fetch?: typeof fetch;
}

export interface HostedClient {
	/** Every published version, newest first. */
	versions(): Promise<string[]>;
	latestVersion(): Promise<string>;
	/** Every mod namespace with hosted icons. */
	namespaces(): Promise<string[]>;
	items(version: string): Promise<HostedItemRegistry>;
	/** Empty when the version publishes no failures file. */
	failures(version: string): Promise<HostedFailure[]>;
	/**
	 * Resolves an id to its hosted icon, or `undefined` when the version's registry
	 * (or, for a modded id, the namespace list) does not have it. A registry entry is
	 * not a guarantee the image exists, so check `failure` and handle load errors.
	 */
	item(id: string, options?: ItemLookupOptions): Promise<HostedItem | undefined>;
}

/** Matches the CDN's own cache on the files that change as versions and mods are added. */
const INDEX_MAX_AGE = 5 * 60 * 1000;

export function createHostedClient(options: HostedClientOptions = {}): HostedClient {
	const baseUrl = options.baseUrl ?? HOSTED_BASE_URL;
	const fetchJson = options.fetch ?? globalThis.fetch;
	const cache = new Map<string, { value: Promise<unknown>; expires: number; }>();
	const registryIndexes = new WeakMap<HostedItemRegistry, Map<string, HostedRegistryItem>>();

	function load<T>(path: string, { maxAge = Infinity, optional = false } = {}): Promise<T> {
		const now = Date.now();
		const hit = cache.get(path);
		if (hit && hit.expires > now) {
			return hit.value as Promise<T>;
		}
		const value = (async () => {
			const response = await fetchJson(baseUrl + path);
			if (optional && response.status === 404) {
				return;
			}
			if (!response.ok) {
				throw new Error(`${baseUrl}${path} answered ${response.status}`);
			}
			return response.json() as Promise<T>;
		})();
		cache.set(path, { value, expires: now + maxAge });
		// A failed request should be retried on the next call, not cached for the client's lifetime.
		value.catch(() => {
			if (cache.get(path)?.value === value) {
				cache.delete(path);
			}
		});
		return value as Promise<T>;
	}

	function versionRoot(version: string): string {
		return `/icons/${encodeURIComponent(version)}`;
	}

	function registryIndex(registry: HostedItemRegistry): Map<string, HostedRegistryItem> {
		let index = registryIndexes.get(registry);
		if (!index) {
			index = new Map(registry.items.map(entry => [entry.id, entry]));
			registryIndexes.set(registry, index);
		}
		return index;
	}

	const client: HostedClient = {
		async versions() {
			const file = await load<{ versions: string[]; }>('/versions.json', { maxAge: INDEX_MAX_AGE });
			return file.versions;
		},

		async latestVersion() {
			const [latest] = await client.versions();
			if (!latest) {
				throw new Error(`${baseUrl}/versions.json lists no versions`);
			}
			return latest;
		},

		namespaces() {
			return load<string[]>('/icons/modded/namespaces.json', { maxAge: INDEX_MAX_AGE });
		},

		items(version) {
			return load<HostedItemRegistry>(`${versionRoot(version)}/items-${encodeURIComponent(version)}.json`);
		},

		async failures(version) {
			const file = await load<HostedFailure[] | undefined>(`${versionRoot(version)}/rc-minecraft-failures.json`, { optional: true });
			return file ?? [];
		},

		async item(id, lookup = {}) {
			const { namespace, path } = parseItemId(id);
			const qualified = `${namespace}:${path}`;
			if (namespace !== 'minecraft') {
				const namespaces = await client.namespaces();
				if (!namespaces.includes(namespace)) {
					return;
				}
				return { id: qualified, url: iconUrl(qualified, { baseUrl }), className: iconClass(qualified) };
			}

			const version = lookup.version ?? await client.latestVersion();
			const [registry, failures] = await Promise.all([client.items(version), client.failures(version)]);
			const entry = registryIndex(registry).get(qualified);
			if (!entry) {
				return;
			}
			let displayName = entry.displayName;
			let iconId = entry.iconId ?? path;
			if (entry.variants) {
				const damage = lookup.damage ?? 0;
				const variant = entry.variants.find(candidate => candidate.damage === damage);
				if (!variant) {
					return;
				}
				displayName = variant.displayName;
				iconId = variant.iconId;
			}

			const iconItem = `minecraft:${iconId}`;
			const item: HostedItem = {
				id: qualified,
				url: iconUrl(iconItem, { version, baseUrl }),
				className: iconClass(iconItem),
				version,
				displayName,
				stackSize: entry.stackSize,
			};
			const failure = failures.find(candidate => candidate.id === iconItem);
			if (failure) {
				item.failure = failure.error;
			}
			return item;
		},
	};
	return client;
}
