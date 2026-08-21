/**
 * Reading `.class` entries out of a jar.
 *
 * `JarResourceManager` deliberately indexes only `assets/` and `data/` — it is a *resource* manager,
 * and a class file is not a resource. But entity geometry lives in the code (see
 * `docs/entity-geometry.md`), so the extractor needs the other half of the archive, and it needs it
 * by internal class name rather than by resource locator.
 *
 * Same shape as the resource manager for the same reason: index the central directory once, then read
 * entries on demand. A client jar holds around eight thousand classes and the extractor touches a
 * hundred of them.
 */

import { UnsafeJarError, isUnsafeEntryPath } from '../resources/jar.ts';
import { openZip } from '../resources/zip-reader.ts';

import type { Entry, ZipFile } from 'yauzl';

interface ClassIndex {
	zip: ZipFile;
	/** Internal name (`fvd`, `gke$a`) → entry. */
	entries: Map<string, Entry>;
}

/** What the extractor reads code out of: one jar, or several layered into one view. */
export interface ClassSource {
	list: () => Promise<string[]>;
	read: (internalName: string) => Promise<Uint8Array | null>;
	close: () => Promise<void>;
}

/**
 * Several jars as one class view, first match winning — the same layering the resource managers use.
 *
 * A modded export needs this, and needed it before cross-jar linking did: the class source used to be
 * the client jar alone, so a mod's own model classes were never read and its mobs came out as boxes
 * however good the interpreter was. Layered, one view holds both, which is also what lets a mod entity
 * link to a *vanilla* model — `ars_nouveau:summon_horse` is the game's own horse.
 */
export function layeredClasses(sources: readonly ClassSource[]): ClassSource {
	/*
	 * A layer that cannot be read is skipped rather than fatal, because a mod jar that cannot be read at
	 * all is a real thing: `tinkers_ingenuity-1.4.5beta.jar` ships a stored entry whose compressed and
	 * uncompressed sizes disagree, and yauzl refuses the archive. The *resource* side already rejects
	 * such a jar and carries on with the rest of the pack, so the class side has to agree — otherwise one
	 * malformed jar out of fourteen hundred takes the whole export down with it.
	 */
	return {
		list: async () => {
			const names = new Set<string>();
			for (const source of sources) {
				try {
					for (const name of await source.list()) {
						names.add(name);
					}
				} catch {
					continue;
				}
			}
			return [...names];
		},
		read: async (internalName) => {
			for (const source of sources) {
				try {
					const bytes = await source.read(internalName);
					if (bytes) {
						return bytes;
					}
				} catch {
					continue;
				}
			}
			return null;
		},
		close: async () => {
			for (const source of sources) {
				try {
					await source.close();
				} catch {
					continue;
				}
			}
		},
	};
}

/** Reads class files out of one jar, by internal name. */
export class JarClassReader {
	private readonly jarPath: string;
	private index: Promise<ClassIndex> | null = null;

	constructor(jarPath: string) {
		this.jarPath = jarPath;
	}

	private getIndex(): Promise<ClassIndex> {
		this.index ??= (async () => {
			const zip = await openZip(this.jarPath);
			return await new Promise<ClassIndex>((resolve, reject) => {
				const entries = new Map<string, Entry>();
				zip.on('entry', (entry: Entry) => {
					if (isUnsafeEntryPath(entry.fileName)) {
						zip.close();
						reject(new UnsafeJarError(`Unsafe entry in ${this.jarPath}: ${entry.fileName}`));
						return;
					}
					if (entry.fileName.endsWith('.class')) {
						// Keyed by internal name, which is what a constant pool and a mapping both use
						entries.set(entry.fileName.slice(0, -'.class'.length), entry);
					}
					zip.readEntry();
				});
				zip.on('end', () => resolve({ zip, entries }));
				zip.on('error', reject);
				zip.readEntry();
			});
		})();
		return this.index;
	}

	/** Every class in the jar, for a sweep that does not know what it is looking for. */
	async list(): Promise<string[]> {
		const index = await this.getIndex();
		return index.entries.keys().toArray();
	}

	async read(internalName: string): Promise<Uint8Array | null> {
		const index = await this.getIndex();
		const entry = index.entries.get(internalName.replaceAll('.', '/'));
		if (!entry) {
			return null;
		}
		return await new Promise((resolve, reject) => {
			index.zip.openReadStream(entry, (err, stream) => {
				if (err) {
					reject(err);
					return;
				}
				const chunks: Buffer[] = [];
				stream.on('data', (chunk) => {
					chunks.push(chunk as Buffer);
				});
				stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
				stream.on('error', reject);
			});
		});
	}

	async close(): Promise<void> {
		if (this.index) {
			const index = await this.index;
			index.zip.close();
		}
	}
}
