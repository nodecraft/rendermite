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
	/**
	 * Members, for code that names the game's classes by their *original* names against a jar that
	 * does not: a mod compiled against Mojang mappings calls `BlockBehaviour$Properties.ofFullCopy` and
	 * reads `Blocks.TORCH`, and following either into an obfuscated client means renaming both.
	 *
	 * Fields by `owner.name`, methods by `owner.name(descriptor)` — original names throughout, the
	 * descriptor in JVM form with original class names. Empty for an identity mapping, where nothing
	 * needs renaming.
	 */
	fieldOf: Map<string, string>;
	methodOf: Map<string, string>;
	/**
	 * The other way: a member as the obfuscated client spells it (`eea$d.a(FF)Leea$d;`) to its original
	 * name (`strength`), for reading what the game's own code calls. Absent for an identity mapping.
	 */
	nameOf?: Map<string, string>;
}

const PRIMITIVE_DESCRIPTORS: Record<string, string> = {
	void: 'V',
	boolean: 'Z',
	byte: 'B',
	char: 'C',
	short: 'S',
	int: 'I',
	long: 'J',
	float: 'F',
	double: 'D',
};

/** A ProGuard type (`java.util.function.ToIntFunction`, `int[]`) as a JVM descriptor, class names untouched. */
function typeDescriptor(type: string): string {
	let dimensions = 0;
	let base = type;
	while (base.endsWith('[]')) {
		base = base.slice(0, -2);
		dimensions++;
	}
	const scalar = PRIMITIVE_DESCRIPTORS[base] ?? `L${base.replaceAll('.', '/')};`;
	return `${'['.repeat(dimensions)}${scalar}`;
}

/**
 * A descriptor with every class in it renamed through the map: `(Lnet/minecraft/…/Block;)V` on an
 * obfuscated jar is `(Ldfy;)V`. Unmapped classes — `java/lang/String`, a mod's own — stay as they are.
 */
export function remapDescriptor(descriptor: string, obfuscatedOf: Map<string, string>): string {
	return descriptor.replaceAll(/L([^;]+);/g, (whole, name: string) => {
		const mapped = obfuscatedOf.get(name.replaceAll('/', '.'));
		return mapped ? `L${mapped.replaceAll('.', '/')};` : whole;
	});
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

/**
 * Parses a ProGuard mapping file: the class lines, and the member lines under each.
 *
 * Members were skipped for years because the geometry extractor works on descriptor shape rather
 * than member names. Block light needs them: it follows a mod's `Blocks.TORCH` into the client jar,
 * and that is a field rename the class map alone cannot make.
 *
 * A method line is `[start:end:]returnType name(paramTypes) -> obf`; the line numbers are dropped
 * and the types become a JVM descriptor in the *original* names, which is how a mod's constant pool
 * spells the reference and so is the key a lookup arrives with.
 */
export function parseMappings(text: string): Mappings {
	const obfuscatedOf = new Map<string, string>();
	const originalOf = new Map<string, string>();
	const fieldOf = new Map<string, string>();
	const methodOf = new Map<string, string>();
	// Held until every class is known, since a method's obfuscated descriptor names classes declared after it
	const methods: Array<{ owner: string; name: string; descriptor: string; obfuscated: string; }> = [];
	const fields: Array<{ owner: string; name: string; obfuscated: string; }> = [];
	let owner = '';
	for (const line of text.split('\n')) {
		if (line.length === 0 || line.startsWith('#')) {
			continue;
		}
		const divider = line.indexOf(' -> ');
		if (divider === -1) {
			continue;
		}
		const obfuscated = line.slice(divider + 4).trim().replace(/:$/, '');
		if (obfuscated.length === 0) {
			continue;
		}
		if (!line.startsWith(' ') && !line.startsWith('\t')) {
			owner = line.slice(0, divider).trim();
			if (owner.length > 0) {
				obfuscatedOf.set(owner, obfuscated);
				originalOf.set(obfuscated, owner);
			}
			continue;
		}
		// A member of the class above it: `type name` for a field, `type name(params)` for a method
		const member = line.slice(0, divider).trim().replace(/^\d+:\d+:/, '');
		const space = member.indexOf(' ');
		if (space === -1 || owner.length === 0) {
			continue;
		}
		const returnType = member.slice(0, space);
		const signature = member.slice(space + 1);
		const open = signature.indexOf('(');
		if (open === -1) {
			fieldOf.set(`${owner}.${signature}`, obfuscated);
			fields.push({ owner, name: signature, obfuscated });
			continue;
		}
		const name = signature.slice(0, open);
		const params = signature.slice(open + 1, -1);
		const descriptor = `(${params.length === 0 ? '' : params.split(',').map(param => typeDescriptor(param.trim())).join('')})${typeDescriptor(returnType)}`;
		methodOf.set(`${owner}.${name}${descriptor}`, obfuscated);
		methods.push({ owner, name, descriptor, obfuscated });
	}
	const nameOf = new Map<string, string>();
	for (const field of fields) {
		nameOf.set(`${obfuscatedOf.get(field.owner)}.${field.obfuscated}`, field.name);
	}
	for (const method of methods) {
		nameOf.set(`${obfuscatedOf.get(method.owner)}.${method.obfuscated}${remapDescriptor(method.descriptor, obfuscatedOf)}`, method.name);
	}
	return { obfuscatedOf, originalOf, fieldOf, methodOf, nameOf };
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
	return { obfuscatedOf, originalOf, fieldOf: new Map(), methodOf: new Map() };
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
