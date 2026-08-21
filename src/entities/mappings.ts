/**
 * Mojang's official obfuscation mappings, which are what turn a jar full of `fvd.class` into named
 * entity models.
 *
 * Published per version in the same manifest the client jar comes from — `downloads.client_mappings`,
 * about 9 MB — so this is a second download from a place the pipeline already goes. Deliberately not
 * the mcversions index `download.ts` uses for jars: that index carries jars only.
 *
 * ProGuard format, which is two kinds of line:
 *
 *     net.minecraft.client.model.CowModel -> fvd:
 *         net.minecraft...LayerDefinition createBodyLayer() -> a
 *
 * Unindented lines map a class, indented ones its members. Only classes are read here; the geometry
 * extractor works on descriptor shape rather than member names, so member mappings buy nothing.
 *
 * Published from 1.14.4 through 1.21.11, and then not again — because from the 26 line Mojang stopped
 * *obfuscating* the client. A 26.2 jar ships `net/minecraft/client/model/ambient/BatModel.class` under
 * its real name, so the mapping it needs is the identity one, which `identityMappings` builds from the
 * jar's own class list.
 *
 * That leaves 1.13.x as the only gap: obfuscated, and predating published mappings. Reported rather
 * than worked around.
 */

import { existsSync } from 'node:fs';
import {
	mkdir,
	readFile,
	rename,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const VERSION_MANIFEST = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json';

/** Class names both ways round, which is what every lookup here needs. */
export interface Mappings {
	/** `net.minecraft.client.model.CowModel` → `fvd`. */
	obfuscatedOf: Map<string, string>;
	/** `fvd` → `net.minecraft.client.model.CowModel`. */
	originalOf: Map<string, string>;
}

export class MappingsUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'MappingsUnavailableError';
	}
}

/**
 * Downloads a version's client mappings, caching by version beside the jars.
 *
 * Throws rather than returning null: a caller that asked for mappings cannot do its job without them,
 * and the difference between "this version publishes none" and "the network failed" is worth keeping.
 */
export async function downloadClientMappings(version: string, cacheDir: string): Promise<string> {
	const target = path.join(cacheDir, `${version}-client-mappings.txt`);
	if (existsSync(target)) {
		return target;
	}
	await mkdir(cacheDir, { recursive: true });

	const manifestResponse = await fetch(VERSION_MANIFEST);
	if (!manifestResponse.ok) {
		throw new MappingsUnavailableError(`Version manifest fetch failed: ${manifestResponse.status}`);
	}
	const manifest = await manifestResponse.json() as { versions?: Array<{ id: string; url: string; }>; };
	const entry = manifest.versions?.find(candidate => candidate.id === version);
	if (!entry) {
		throw new MappingsUnavailableError(`${version} is not in Mojang's version manifest`);
	}
	const metaResponse = await fetch(entry.url);
	if (!metaResponse.ok) {
		throw new MappingsUnavailableError(`Version metadata fetch failed for ${version}: ${metaResponse.status}`);
	}
	const meta = await metaResponse.json() as { downloads?: Record<string, { url: string; }>; };
	const mappings = meta.downloads?.client_mappings;
	if (!mappings) {
		throw new MappingsUnavailableError(`${version} publishes no client mappings; they start at 1.14.4`);
	}
	const download = await fetch(mappings.url);
	if (!download.ok) {
		throw new MappingsUnavailableError(`Mappings download failed for ${version}: ${download.status}`);
	}
	// Temp name so an interrupted download never looks cached
	const partial = `${target}.partial`;
	await writeFile(partial, Buffer.from(await download.arrayBuffer()));
	await rename(partial, target);
	return target;
}

/** Parses the class lines of a ProGuard mapping file. */
export function parseMappings(text: string): Mappings {
	const obfuscatedOf = new Map<string, string>();
	const originalOf = new Map<string, string>();
	for (const line of text.split('\n')) {
		// Indented is a member, `#` is the header comment, and a class line always has the arrow
		if (line.length === 0 || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('#')) {
			continue;
		}
		const divider = line.indexOf(' -> ');
		if (divider === -1) {
			continue;
		}
		const original = line.slice(0, divider).trim();
		const obfuscated = line.slice(divider + 4).trim().replace(/:$/, '');
		if (original.length === 0 || obfuscated.length === 0) {
			continue;
		}
		obfuscatedOf.set(original, obfuscated);
		originalOf.set(obfuscated, original);
	}
	return { obfuscatedOf, originalOf };
}

export async function loadMappings(version: string, cacheDir: string): Promise<Mappings> {
	return parseMappings(await readFile(await downloadClientMappings(version, cacheDir), 'utf8'));
}

/**
 * Mappings for a jar that was never obfuscated: every class maps to itself.
 *
 * `internalNames` are as the archive spells them (`net/minecraft/client/model/animal/cow/CowModel`);
 * the maps use dots, because that is what a mapping file and every lookup here use.
 */
export function identityMappings(internalNames: Iterable<string>): Mappings {
	const obfuscatedOf = new Map<string, string>();
	const originalOf = new Map<string, string>();
	for (const internal of internalNames) {
		const dotted = internal.replaceAll('/', '.');
		obfuscatedOf.set(dotted, dotted);
		originalOf.set(dotted, dotted);
	}
	return { obfuscatedOf, originalOf };
}

/**
 * Whether a jar still needs a mapping at all.
 *
 * Decided on the **models package**, not on `net/minecraft/` generally: an obfuscated jar keeps a
 * couple of dozen classes in the clear — the launcher entrypoint and the brand retriever are never
 * obfuscated — so 1.21.1 has 26 `net/minecraft/` entries and zero under `client/model/`, where 26.2
 * has 358. Which is also the precise question the extractor is asking.
 */
export function isObfuscated(internalNames: Iterable<string>): boolean {
	for (const name of internalNames) {
		if (name.startsWith('net/minecraft/client/model/')) {
			return false;
		}
	}
	return true;
}

/**
 * The mappings for a version, however it ships them.
 *
 * **The jar decides, not the manifest.** From the 26 line the client is not obfuscated, so its own
 * class names are the real ones and no mapping is needed — asking Mojang first would mean two HTTP
 * requests per export to learn something the archive already states, and would make an offline export
 * of a current version fail for no reason.
 */
export async function resolveMappings(
	version: string,
	cacheDir: string,
	listClasses: () => Promise<string[]>,
): Promise<{ mappings: Mappings; obfuscated: boolean; }> {
	const names = await listClasses();
	if (!isObfuscated(names)) {
		return { mappings: identityMappings(names), obfuscated: false };
	}
	try {
		return { mappings: await loadMappings(version, cacheDir), obfuscated: true };
	} catch (err) {
		if (!(err instanceof MappingsUnavailableError)) {
			throw err;
		}
		/*
		 * Obfuscated *and* unmapped is 1.13-era, from before Mojang published the maps. Nothing can be
		 * linked there, and saying so beats exporting an empty entity table as though the version simply
		 * had no mobs.
		 */
		throw new MappingsUnavailableError(
			`${version} publishes no mappings and its jar is obfuscated; entity geometry needs 1.14.4 or newer`,
			{ cause: err },
		);
	}
}
