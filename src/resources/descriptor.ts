/**
 * Serializable descriptions of a resource tree, so the same layered tree can be
 * rebuilt inside a worker thread. Managers describe themselves; a tree
 * containing anything that cannot (a consumer's own ResourceManager) describes
 * as null, and the caller renders in-process rather than silently dropping
 * layers.
 */

import { JarResourceManager } from './jar.ts';
import { FolderResourceManager, LayeredResourceManager } from './manager.ts';
import { KindFilteredResourceManager, MapResourceManager } from './synthetic.ts';

import type { ResourceKindName, ResourceManager } from './manager.ts';

export type ResourceDescriptor =
	| { kind: 'folder'; root: string; }
	| { kind: 'jar'; path: string; }
	| { kind: 'map'; entries: Array<[string, Uint8Array]>; }
	| { kind: 'layered'; layers: ResourceDescriptor[]; }
	| { kind: 'kindFiltered'; inner: ResourceDescriptor; kinds: ResourceKindName[]; };

/** Managers that can cross a worker boundary implement this. */
export interface DescribableResourceManager extends ResourceManager {
	describe(): ResourceDescriptor | null;
}

export function describeResources(manager: ResourceManager): ResourceDescriptor | null {
	const describable = manager as Partial<DescribableResourceManager>;
	return typeof describable.describe === 'function' ? describable.describe() : null;
}

export function restoreResources(descriptor: ResourceDescriptor): ResourceManager {
	switch (descriptor.kind) {
		case 'folder': {
			return new FolderResourceManager(descriptor.root);
		}
		case 'jar': {
			return new JarResourceManager(descriptor.path);
		}
		case 'map': {
			return MapResourceManager.fromEntries(descriptor.entries);
		}
		case 'layered': {
			return new LayeredResourceManager(descriptor.layers.map(layer => restoreResources(layer)));
		}
		case 'kindFiltered': {
			return new KindFilteredResourceManager(restoreResources(descriptor.inner), descriptor.kinds);
		}
	}
}
