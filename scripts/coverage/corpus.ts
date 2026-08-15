/** Shared paths and catalog access for the coverage harness. */
import fs from 'node:fs';
import path from 'node:path';

/** Game versions the vanilla fixture downloader can supply, newest first. */
export const SUPPORTED_VERSIONS = ['26.2', '26.1.2', '1.21.11', '1.21.8', '1.21.4', '1.21.1', '1.20.4', '1.20.1'];

/** Versions whose item models predate the 1.21.4 `items/` definitions. */
export const LEGACY_VERSIONS = new Set(['1.20.1', '1.20.4', '1.21.1']);

const work = path.join(import.meta.dirname, '..', '..', '.work');

export const MODRINTH_DIR = path.join(work, 'fixtures', 'modrinth');
export const CATALOG_PATH = path.join(work, 'coverage', 'catalog.json');
export const DEPENDENCY_PATH = path.join(work, 'coverage', 'dependencies.json');

export interface CatalogEntry {
	/** Game version the jar was fetched for; picks the vanilla jar and the era. */
	game: string;
	version: string;
}

export function jarPath(slug: string): string {
	return path.join(MODRINTH_DIR, `cov-${slug}.jar`);
}

export function readJson<T>(file: string, fallback: T): T {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
	} catch {
		return fallback;
	}
}

export function readCatalog(): Record<string, CatalogEntry> {
	fs.mkdirSync(path.dirname(CATALOG_PATH), { recursive: true });
	return readJson<Record<string, CatalogEntry>>(CATALOG_PATH, {});
}

export function eraFor(game: string): 'legacy' | 'modern' {
	return LEGACY_VERSIONS.has(game) ? 'legacy' : 'modern';
}
