import type { ResourceDescriptor } from './descriptor.ts';
import type { ResourceLocator } from './locator.ts';
import type { ResourceKindName, ResourceManager } from './manager.ts';

/**
 * Remembers directory listings for the lifetime of one render or export.
 *
 * Fallback lookups (mob heads, chests, geo files, sprite fallbacks) scan a
 * whole namespace per item, and every scan re-walked the jar index, re-read
 * the builtin pack from disk and re-deduplicated thousands of locators across
 * layers: one block export listed `minecraft` textures 849 times. The model
 * and texture caches beside it already assume the tree is fixed for the run,
 * so this assumes the same and no more. Reads pass straight through.
 */
export class CachedListingResourceManager implements ResourceManager {
	private readonly inner: ResourceManager;
	private readonly listings = new Map<string, Promise<ResourceLocator[]>>();
	private namespaces: Promise<string[]> | null = null;

	constructor(inner: ResourceManager) {
		this.inner = inner;
	}

	getResource(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer | null> {
		return this.inner.getResource(kind, locator);
	}

	getAllResources(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer[]> {
		return this.inner.getAllResources(kind, locator);
	}

	hasResource(kind: ResourceKindName, locator: ResourceLocator): Promise<boolean> {
		return this.inner.hasResource(kind, locator);
	}

	async listResources(kind: ResourceKindName, namespace: string): Promise<ResourceLocator[]> {
		const key = `${kind} ${namespace}`;
		let listing = this.listings.get(key);
		if (!listing) {
			listing = this.inner.listResources(kind, namespace);
			this.listings.set(key, listing);
			// A failed listing is retried next time, as it would have been uncached
			listing.catch(() => this.listings.delete(key));
		}
		// A copy, because callers own the array they are handed
		return [...await listing];
	}

	async listNamespaces(): Promise<string[]> {
		if (!this.namespaces) {
			const pending = this.inner.listNamespaces();
			this.namespaces = pending;
			pending.catch(() => {
				this.namespaces = null;
			});
		}
		return [...await this.namespaces];
	}

	describe(): ResourceDescriptor | null {
		const describable = this.inner as { describe?: () => ResourceDescriptor | null; };
		return typeof describable.describe === 'function' ? describable.describe() : null;
	}
}
