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
