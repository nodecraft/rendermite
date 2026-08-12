/**
 * Reads resources directly out of a jar/zip — no extraction step, unlike the
 * PHP pipeline which required unpacked trees (and paid dearly for the file
 * count on Docker bind mounts). The central directory is indexed once.
 */

import { open } from 'yauzl';

import { ResourceLocator } from './locator.ts';
import { ResourceKind } from './manager.ts';

import type { ResourceKindName, ResourceManager } from './manager.ts';
import type { Entry, ZipFile } from 'yauzl';

interface JarIndex {
	zip: ZipFile;
	/** entry path → entry, for exact lookups. */
	entries: Map<string, Entry>;
	/**
	 * lowercased path → entry. 1.7.10-era mods ship camelCase asset names
	 * (`itemAdvBat.1.png`) that normalized locators can't hit exactly; first
	 * entry wins so case-only collisions stay deterministic.
	 */
	entriesLower: Map<string, Entry>;
	namespaces: Set<string>;
}

/** Jar entries that could escape the archive get the whole jar rejected. */
export function isUnsafeEntryPath(entryPath: string): boolean {
	return entryPath.startsWith('/')
		|| /^[A-Z]:/i.test(entryPath)
		|| entryPath.split('/').includes('..');
}

export class UnsafeJarError extends Error {}

export class JarResourceManager implements ResourceManager {
	private readonly jarPath: string;
	private index: Promise<JarIndex> | null = null;

	constructor(jarPath: string) {
		this.jarPath = jarPath;
	}

	private getIndex(): Promise<JarIndex> {
		this.index ??= new Promise((resolve, reject) => {
			open(this.jarPath, { lazyEntries: true, autoClose: false }, (err, zip) => {
				if (err) {
					reject(err);
					return;
				}
				const entries = new Map<string, Entry>();
				const entriesLower = new Map<string, Entry>();
				const namespaces = new Set<string>();
				zip.on('entry', (entry: Entry) => {
					if (isUnsafeEntryPath(entry.fileName)) {
						zip.close();
						reject(new UnsafeJarError(`Unsafe entry in ${this.jarPath}: ${entry.fileName}`));
						return;
					}
					const match = /^assets\/([^/]+)\//.exec(entry.fileName);
					if (match) {
						entries.set(entry.fileName, entry);
						const lower = entry.fileName.toLowerCase();
						if (!entriesLower.has(lower)) {
							entriesLower.set(lower, entry);
						}
						namespaces.add(match[1].toLowerCase());
					}
					zip.readEntry();
				});
				zip.on('end', () => resolve({ zip, entries, namespaces, entriesLower }));
				zip.on('error', reject);
				zip.readEntry();
			});
		});
		return this.index;
	}

	private entryPath(kind: ResourceKindName, locator: ResourceLocator): string {
		const { directory, extension } = ResourceKind[kind];
		const prefix = directory === '' ? '' : `${directory}/`;
		return `assets/${locator.namespace}/${prefix}${locator.path}${extension}`;
	}

	async getResource(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer | null> {
		const index = await this.getIndex();
		const entryPath = this.entryPath(kind, locator);
		const entry = index.entries.get(entryPath) ?? index.entriesLower.get(entryPath.toLowerCase());
		if (!entry) {
			return null;
		}
		return new Promise((resolve, reject) => {
			index.zip.openReadStream(entry, (err, stream) => {
				if (err) {
					reject(err);
					return;
				}
				const chunks: Buffer[] = [];
				stream.on('data', (chunk) => {
					chunks.push(chunk as Buffer);
				});
				stream.on('end', () => resolve(Buffer.concat(chunks)));
				stream.on('error', reject);
			});
		});
	}

	async hasResource(kind: ResourceKindName, locator: ResourceLocator): Promise<boolean> {
		const index = await this.getIndex();
		const entryPath = this.entryPath(kind, locator);
		return index.entries.has(entryPath) || index.entriesLower.has(entryPath.toLowerCase());
	}

	async getAllResources(kind: ResourceKindName, locator: ResourceLocator): Promise<Buffer[]> {
		const resource = await this.getResource(kind, locator);
		return resource === null ? [] : [resource];
	}

	async listResources(kind: ResourceKindName, namespace: string): Promise<ResourceLocator[]> {
		const index = await this.getIndex();
		const { directory, extension } = ResourceKind[kind];
		// The raw kind has no directory — its prefix must not double the slash.
		const prefix = directory === '' ? `assets/${namespace}/` : `assets/${namespace}/${directory}/`;
		const locators: ResourceLocator[] = [];
		for (const entryPath of index.entries.keys()) {
			if (!entryPath.startsWith(prefix) || !entryPath.endsWith(extension) || entryPath.endsWith('/')) {
				continue;
			}
			const relative = extension === '' ? entryPath.slice(prefix.length) : entryPath.slice(prefix.length, -extension.length);
			const locator = ResourceLocator.tryParse(`${namespace}:${relative}`);
			if (locator) {
				locators.push(locator);
			}
		}
		return locators;
	}

	async listNamespaces(): Promise<string[]> {
		const index = await this.getIndex();
		return [...index.namespaces].toSorted((left, right) => left.localeCompare(right));
	}

	async close(): Promise<void> {
		if (this.index) {
			const index = await this.index;
			index.zip.close();
			this.index = null;
		}
	}
}
