import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { ResourceLocator } from './locator.ts';

/**
 * A category of resource inside a pack, mapping to a directory under
 * `assets/<namespace>/` plus a file extension.
 */
export const ResourceKind = {
	model: { directory: 'models', extension: '.json' },
	itemDefinition: { directory: 'items', extension: '.json' },
	blockstate: { directory: 'blockstates', extension: '.json' },
	texture: { directory: 'textures', extension: '.png' },
	textureMeta: { directory: 'textures', extension: '.png.mcmeta' },
	atlas: { directory: 'atlases', extension: '.json' },
	lang: { directory: 'lang', extension: '.json' },
	/** Arbitrary file under assets/<ns>/ (OBJ geometry, MTL material libraries). */
	raw: { directory: '', extension: '' },
} as const;

export type ResourceKindName = keyof typeof ResourceKind;

export interface ResourceManager {
	/** Raw bytes for a resource, or null when this manager does not have it. */
	getResource(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer | null>;
	/**
	 * Every copy of a resource across layers, highest precedence first. Most
	 * resources shadow, but atlas definitions merge across packs in the game —
	 * reading only the winning file drops the shadowed pack's sources.
	 */
	getAllResources(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer[]>;
	/** Whether this manager has the resource without reading it. */
	hasResource(kind: ResourceKindName, locator: ResourceLocator): Promise<boolean>;
	/** All resource paths of a kind within a namespace (locator paths, no extension). */
	listResources(kind: ResourceKindName, namespace: string): Promise<ResourceLocator[]>;
	/** All namespaces this manager provides. */
	listNamespaces(): Promise<string[]>;
}

/**
 * Reads a resource pack laid out on disk. Accepts both layouts in the wild:
 * `<root>/assets/<ns>/…` (an extracted jar/pack) and `<root>/<ns>/…`
 * (what renderchest's --assets and the ui pipeline pass).
 */
export class FolderResourceManager implements ResourceManager {
	readonly root: string;

	constructor(root: string) {
		this.root = existsSync(path.join(root, 'assets')) ? path.join(root, 'assets') : root;
	}

	private resolve(kind: ResourceKindName, locator: ResourceLocator): string {
		const { directory, extension } = ResourceKind[kind];
		return path.join(this.root, locator.namespace, directory, `${locator.path}${extension}`);
	}

	async getResource(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer | null> {
		try {
			return await readFile(this.resolve(kind, locator));
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return null;
			}
			throw err;
		}
	}

	async hasResource(kind: ResourceKindName, locator: ResourceLocator): Promise<boolean> {
		return await this.getResource(kind, locator) !== null;
	}

	async getAllResources(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer[]> {
		const resource = await this.getResource(kind, locator);
		return resource === null ? [] : [resource];
	}

	async listResources(kind: ResourceKindName, namespace: string): Promise<ResourceLocator[]> {
		const { directory, extension } = ResourceKind[kind];
		const base = path.join(this.root, namespace, directory);
		let entries;
		try {
			entries = await readdir(base, { recursive: true, withFileTypes: true });
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw err;
		}
		const locators: ResourceLocator[] = [];
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.endsWith(extension)) {
				continue;
			}
			const full = path.join(entry.parentPath, entry.name);
			const relative = path.relative(base, full).replaceAll('\\', '/');
			const locator = ResourceLocator.tryParse(`${namespace}:${relative.slice(0, -extension.length)}`);
			// Files with unnormalizable names can't be referenced by any model; skip them.
			if (locator) {
				locators.push(locator);
			}
		}
		return locators;
	}

	async listNamespaces(): Promise<string[]> {
		try {
			const entries = await readdir(this.root, { withFileTypes: true });
			return entries.filter(entry => entry.isDirectory()).map(entry => entry.name);
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw err;
		}
	}
}

/**
 * Layers several managers; earlier managers win, matching resource-pack precedence.
 * The builtin pack goes first, then mod/version overlays, then the base assets.
 */
export class LayeredResourceManager implements ResourceManager {
	readonly layers: ResourceManager[];

	constructor(layers: ResourceManager[]) {
		this.layers = layers;
	}

	async getResource(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer | null> {
		for (const layer of this.layers) {
			const resource = await layer.getResource(kind, locator);
			if (resource !== null) {
				return resource;
			}
		}
		return null;
	}

	async hasResource(kind: ResourceKindName, locator: ResourceLocator): Promise<boolean> {
		for (const layer of this.layers) {
			if (await layer.hasResource(kind, locator)) {
				return true;
			}
		}
		return false;
	}

	async getAllResources(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer[]> {
		const all: Buffer[] = [];
		for (const layer of this.layers) {
			all.push(...await layer.getAllResources(kind, locator));
		}
		return all;
	}

	async listResources(kind: ResourceKindName, namespace: string): Promise<ResourceLocator[]> {
		const seen = new Set<string>();
		const merged: ResourceLocator[] = [];
		for (const layer of this.layers) {
			for (const locator of await layer.listResources(kind, namespace)) {
				const key = locator.toString();
				if (!seen.has(key)) {
					seen.add(key);
					merged.push(locator);
				}
			}
		}
		return merged;
	}

	async listNamespaces(): Promise<string[]> {
		const namespaces = new Set<string>();
		for (const layer of this.layers) {
			for (const namespace of await layer.listNamespaces()) {
				namespaces.add(namespace);
			}
		}
		return [...namespaces].toSorted((left, right) => left.localeCompare(right));
	}
}
