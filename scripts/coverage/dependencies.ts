/**
 * Indexes the cached corpus by the mod ids each jar provides and requires:
 *
 *   node scripts/coverage/dependencies.ts
 *
 * This exists because surveying an addon without its dependency invents
 * failures. Half of one 1,200-mod sweep's failures were Create addons measured
 * without Create — see docs/research/mod-coverage-campaign.md. Reading `depends`
 * out of the jars we already hold resolves that with no network.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { DEPENDENCY_PATH, jarPath, readCatalog } from './corpus.ts';
import { JarResourceManager } from '../../src/resources/jar.ts';

/** Loader and platform ids that are never a renderable jar in the corpus. */
const PLATFORM = new Set([
	'minecraft',
	'forge',
	'neoforge',
	'fabric',
	'fabricloader',
	'fabric-api',
	'java',
	'quilt_loader',
	'quilted_fabric_api',
	'mixinextras',
	'kotlinforforge',
	'kotlin-for-forge',
]);

export interface DependencyIndex {
	/** mod id → slugs providing it. */
	provides: Record<string, string[]>;
	/** slug → required mod ids. */
	needs: Record<string, string[]>;
}

function entry(jar: string, name: string): string | null {
	try {
		return execFileSync('unzip', ['-p', jar, name], { encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] });
	} catch {
		return null;
	}
}

/** Ids a Forge/NeoForge `mods.toml` declares, split into provided and required. */
function parseToml(toml: string): { ids: string[]; depends: string[]; } {
	const ids: string[] = [];
	const depends: string[] = [];
	let inDependencies = false;
	let block: string[] = [];
	const flush = (): void => {
		const text = block.join('\n');
		block = [];
		const id = /modId\s*=\s*"([^"]+)"/.exec(text)?.[1];
		if (!id || PLATFORM.has(id)) {
			return;
		}
		if (!inDependencies) {
			ids.push(id);
			return;
		}
		// Optional integrations are not needed to resolve a model, and loading
		// them would widen every survey for no coverage gain.
		if (!/type\s*=\s*"optional"/.test(text) && !/mandatory\s*=\s*false/.test(text)) {
			depends.push(id);
		}
	};
	for (const line of toml.split('\n')) {
		const header = /^\s*\[\[(\w+)/.exec(line);
		if (header) {
			flush();
			inDependencies = header[1] === 'dependencies';
			continue;
		}
		block.push(line);
	}
	flush();
	return { ids, depends };
}

function metadata(jar: string): { ids: string[]; depends: string[]; } | null {
	const fabric = entry(jar, 'fabric.mod.json');
	if (fabric) {
		try {
			const json = JSON.parse(fabric) as { id?: string; provides?: string[]; depends?: Record<string, unknown>; };
			return {
				ids: [json.id, ...json.provides ?? []].filter((id): id is string => typeof id === 'string'),
				depends: Object.keys(json.depends ?? {}).filter(id => !PLATFORM.has(id)),
			};
		} catch {
			return null;
		}
	}
	const toml = entry(jar, 'META-INF/neoforge.mods.toml') ?? entry(jar, 'META-INF/mods.toml');
	return toml ? parseToml(toml) : null;
}

/** Models to read per jar when inferring undeclared dependencies. */
const MODEL_SAMPLE = 150;

/**
 * Namespaces a jar's own models reference but do not belong to it. Metadata is
 * not enough: compat mods routinely reference a mod they never declare —
 * macaws-biomes-o-plenty parents onto `mcwfences:block/parent/wall_inventory`
 * while its mods.toml names only Biomes O' Plenty, so 1,527 of its 2,047 items
 * were scored as failures for a dependency the index could not know about. What
 * the assets ask for is the honest signal.
 */
async function referencedNamespaces(jarFile: string, own: Set<string>): Promise<string[]> {
	const manager = new JarResourceManager(jarFile);
	const foreign = new Set<string>();
	try {
		for (const namespace of own) {
			const models = await manager.listResources('model', namespace);
			// A compat mod repeats the same few references throughout, so a sample
			// finds them all far cheaper than reading thousands of files.
			const step = Math.max(1, Math.floor(models.length / MODEL_SAMPLE));
			for (let index = 0; index < models.length; index += step) {
				const raw = await manager.getResource('model', models[index]);
				for (const match of (raw?.toString('utf8') ?? '').matchAll(/"([a-z\d_.-]+):[a-z\d_./-]+"/g)) {
					if (!own.has(match[1]) && !PLATFORM.has(match[1]) && match[1] !== 'minecraft') {
						foreign.add(match[1]);
					}
				}
			}
		}
	} catch {
		// An unreadable jar simply contributes nothing.
	} finally {
		await manager.close().catch(() => {});
	}
	return [...foreign];
}

const catalog = readCatalog();
const index: DependencyIndex = { provides: {}, needs: {} };
for (const slug of Object.keys(catalog)) {
	const jar = jarPath(slug);
	if (!fs.existsSync(jar)) {
		continue;
	}
	const meta = metadata(jar);
	if (!meta) {
		continue;
	}
	for (const id of meta.ids) {
		index.provides[id] = [...index.provides[id] ?? [], slug];
	}
	const inferred = await referencedNamespaces(jar, new Set(meta.ids));
	index.needs[slug] = [...new Set([...meta.depends, ...inferred])];
}
fs.writeFileSync(DEPENDENCY_PATH, `${JSON.stringify(index, null, '\t')}\n`);
const withDeps = Object.values(index.needs).filter(list => list.length > 0).length;
console.log(`indexed ${Object.keys(index.needs).length} jars, ${Object.keys(index.provides).length} mod ids, ${withDeps} with required deps`);
