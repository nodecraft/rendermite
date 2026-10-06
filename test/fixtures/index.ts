/**
 * First-class test fixtures. Nothing here references a developer machine:
 * vanilla client jars download on demand from Mojang (via mcversions.net's
 * index) into `.work/fixtures/`, and mod jars are built from the committed
 * synthetic sources in `test/fixtures/mods/` (see mods.ts). Real third-party
 * mod jars are license-restricted and cannot be committed — the optional
 * suite that uses them is gated on the RENDERMITE_MODJARS env variable.
 */

import { existsSync } from 'node:fs';
import {
	mkdir,
	readFile,
	rename,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';

export const fixturesDir = path.join(import.meta.dirname, '..', '..', '.work', 'fixtures');

export const vanillaJar = (version: string): string => path.join(fixturesDir, `${version}-client.jar`);

/** Retryable transport failures and the server statuses worth another attempt. */
const RETRY_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_DELAYS = [1000, 3000, 8000];

/**
 * Fixture downloads are the only network dependency in the suite, and a single
 * dropped connection to Mojang's or Modrinth's CDN would otherwise fail CI on a
 * flake rather than on anything about the code.
 */
async function fetchRetry(url: string, init?: RequestInit): Promise<Response> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
		if (attempt > 0) {
			await new Promise((resolve) => {
				setTimeout(resolve, RETRY_DELAYS[attempt - 1]);
			});
		}
		try {
			const response = await fetch(url, init);
			if (response.ok || !RETRY_STATUS.has(response.status)) {
				return response;
			}
			lastError = new Error(`${url} responded ${response.status}`);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

interface VersionIndex {
	stable: Record<string, { client: string; }>;
	snapshot: Record<string, { client: string; }>;
}

let indexPromise: Promise<VersionIndex> | null = null;
let refreshed = false;

async function versionIndex(refresh = false): Promise<VersionIndex> {
	// CI restores older fixture caches, so a cached index can predate a version a suite just added.
	if (refresh && !refreshed) {
		refreshed = true;
		indexPromise = null;
	}
	indexPromise ??= (async () => {
		const cache = path.join(fixturesDir, 'mcversions.json');
		if (refreshed || !existsSync(cache)) {
			await mkdir(fixturesDir, { recursive: true });
			const response = await fetchRetry('https://mcversions.net/mcversions.json');
			if (!response.ok) {
				throw new Error(`mcversions.net index fetch failed: ${response.status}`);
			}
			await writeFile(cache, Buffer.from(await response.arrayBuffer()));
		}
		return JSON.parse(await readFile(cache, 'utf8')) as VersionIndex;
	})();
	// A rejected promise must not stick, or one flake fails every later version.
	indexPromise.catch(() => {
		indexPromise = null;
	});
	return indexPromise;
}

/** Download a version's client jar if it isn't cached yet; returns its path. */
export async function ensureVanillaJar(version: string): Promise<string> {
	const jarPath = vanillaJar(version);
	if (existsSync(jarPath)) {
		return jarPath;
	}
	const lookup = (index: VersionIndex) => index.stable[version] ?? index.snapshot[version];
	const entry = lookup(await versionIndex()) ?? lookup(await versionIndex(true));
	if (!entry) {
		throw new Error(`Version ${version} not found in the mcversions index`);
	}
	await mkdir(fixturesDir, { recursive: true });
	const response = await fetchRetry(entry.client);
	if (!response.ok) {
		throw new Error(`Client jar download failed for ${version}: ${response.status}`);
	}
	// Write via a temp name so an interrupted download never looks cached.
	const partial = `${jarPath}.partial`;
	await writeFile(partial, Buffer.from(await response.arrayBuffer()));
	await rename(partial, jarPath);
	return jarPath;
}

/** Real third-party mod jars (optional): set RENDERMITE_MODJARS to a directory of jars. */
export function realModJarsDir(): string | null {
	return process.env.RENDERMITE_MODJARS ?? null;
}

export interface ModrinthSpec {
	slug: string;
	gameVersion: string;
	loader: 'forge' | 'neoforge' | 'fabric';
	/** Pin an exact version_number for deterministic CI runs. */
	versionNumber?: string;
}

interface ModrinthVersion {
	version_number: string;
	files: Array<{ url: string; filename: string; primary: boolean; }>;
}

/**
 * Download a mod jar from Modrinth at test time (cached in .work/fixtures/
 * modrinth/), the same runtime-sourcing model as the vanilla jars — nothing
 * license-restricted is ever committed, and CI only needs network access.
 */
export async function ensureModrinthJar(spec: ModrinthSpec): Promise<string> {
	const directory = path.join(fixturesDir, 'modrinth');
	const cacheName = `${spec.slug}-${spec.loader}-${spec.versionNumber ?? spec.gameVersion}.jar`;
	const jarPath = path.join(directory, cacheName);
	if (existsSync(jarPath)) {
		return jarPath;
	}
	await mkdir(directory, { recursive: true });
	const query = new URLSearchParams({
		game_versions: JSON.stringify([spec.gameVersion]),
		loaders: JSON.stringify([spec.loader]),
	});
	const response = await fetchRetry(`https://api.modrinth.com/v2/project/${spec.slug}/version?${query}`, {
		headers: { 'user-agent': 'nodecraft/renderchest tests (https://nodecraft.com)' },
	});
	if (!response.ok) {
		throw new Error(`Modrinth version list failed for ${spec.slug}: ${response.status}`);
	}
	const versions = await response.json() as ModrinthVersion[];
	const version = spec.versionNumber
		? versions.find(entry => entry.version_number === spec.versionNumber)
		: versions[0];
	if (!version) {
		throw new Error(`No matching Modrinth version for ${spec.slug} ${spec.versionNumber ?? spec.gameVersion}`);
	}
	const file = version.files.find(entry => entry.primary) ?? version.files[0];
	const download = await fetchRetry(file.url);
	if (!download.ok) {
		throw new Error(`Modrinth download failed for ${spec.slug}: ${download.status}`);
	}
	const partial = `${jarPath}.partial`;
	await writeFile(partial, Buffer.from(await download.arrayBuffer()));
	await rename(partial, jarPath);
	return jarPath;
}
