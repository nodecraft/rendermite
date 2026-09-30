import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { ResourceLocator } from './locator.ts';

import type { ResourceDescriptor } from './descriptor.ts';

/**
 * A category of resource inside a pack, mapping to a directory under
 * `<root>/<namespace>/` plus a file extension.
 *
 * `root` is `assets` for everything a renderer draws with. Biome definitions are
 * the exception: they are *data*, not assets, so a jar keeps them under `data/`
 * and a manager that assumed `assets/` could never see them.
 */
export const ResourceKind = {
	model: { root: 'assets', directory: 'models', extension: '.json' },
	itemDefinition: { root: 'assets', directory: 'items', extension: '.json' },
	blockstate: { root: 'assets', directory: 'blockstates', extension: '.json' },
	texture: { root: 'assets', directory: 'textures', extension: '.png' },
	textureMeta: { root: 'assets', directory: 'textures', extension: '.png.mcmeta' },
	atlas: { root: 'assets', directory: 'atlases', extension: '.json' },
	lang: { root: 'assets', directory: 'lang', extension: '.json' },
	/** Arbitrary file under assets/<ns>/ (OBJ geometry, MTL material libraries). */
	raw: { root: 'assets', directory: '', extension: '' },
	/** A datapack biome: climate and the colours a renderer tints its blocks with. */
	biome: { root: 'data', directory: 'worldgen/biome', extension: '.json' },
	/** Any datapack JSON under data/<ns>/: tags, advancements, whatever the version ships as data. */
	data: { root: 'data', directory: '', extension: '.json' },
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
	/** What `root` was before the `assets/` layout was detected, so `data/` is reachable too. */
	private readonly packRoot: string;

	readonly root: string;

	constructor(root: string) {
		this.packRoot = root;
		this.root = existsSync(path.join(root, 'assets')) ? path.join(root, 'assets') : root;
	}

	/** Where a kind's namespaces live: the detected assets root, or a sibling of it. */
	private base(kind: ResourceKindName, namespace: string): string {
		const { root, directory } = ResourceKind[kind];
		const rooted = root === 'assets' ? this.root : path.join(this.packRoot, root);
		return path.join(rooted, namespace, directory);
	}

	private resolve(kind: ResourceKindName, locator: ResourceLocator): string {
		const { extension } = ResourceKind[kind];
		return path.join(this.base(kind, locator.namespace), `${locator.path}${extension}`);
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
		// stat, not readFile: existence is checked once per discovered item, and
		// reading every candidate model in full to answer "is this an item?" cost
		// the whole file's bytes for a boolean.
		try {
			const stats = await stat(this.resolve(kind, locator));
			return stats.isFile();
		} catch {
			return false;
		}
	}

	async getAllResources(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer[]> {
		const resource = await this.getResource(kind, locator);
		return resource === null ? [] : [resource];
	}

	async listResources(kind: ResourceKindName, namespace: string): Promise<ResourceLocator[]> {
		const { extension } = ResourceKind[kind];
		const base = this.base(kind, namespace);
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

	describe(): ResourceDescriptor {
		return { kind: 'folder', root: this.root };
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

	describe(): ResourceDescriptor | null {
		const layers: ResourceDescriptor[] = [];
		for (const layer of this.layers) {
			const described = describeLayer(layer);
			// One indescribable layer makes the whole tree indescribable: a partial
			// tree would render missing textures instead of failing.
			if (!described) {
				return null;
			}
			layers.push(described);
		}
		return { kind: 'layered', layers };
	}
}

/** Local copy of describeResources, avoiding an import cycle with descriptor.ts. */
function describeLayer(manager: ResourceManager): ResourceDescriptor | null {
	const describable = manager as { describe?: () => ResourceDescriptor | null; };
	return typeof describable.describe === 'function' ? describable.describe() : null;
}
