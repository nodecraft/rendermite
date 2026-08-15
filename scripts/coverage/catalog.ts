/**
 * Builds the coverage corpus: enumerate Modrinth by downloads, fetch a jar per
 * mod, and record which game version each was fetched for.
 *
 *   node scripts/coverage/catalog.ts 1200          # top 1200 mods by downloads
 *   node scripts/coverage/catalog.ts --slugs a b   # named mods
 *
 * Ranking by downloads rather than curating a list is deliberate: it weights the
 * corpus by what people actually install, and it scales without judgement calls.
 * Jars land in .work/fixtures/modrinth/cov-<slug>.jar and are never re-fetched,
 * so re-running after a renderer change costs no network.
 */
import fs from 'node:fs';

import {
	CATALOG_PATH,
	MODRINTH_DIR,
	SUPPORTED_VERSIONS,
	jarPath,
	readCatalog,
} from './corpus.ts';

const AGENT = { 'user-agent': 'nodecraft/rendermite' };

interface ModrinthVersion {
	game_versions: string[];
	loaders: string[];
	version_number: string;
	files: Array<{ url: string; primary: boolean; }>;
}

/** Slugs of the top `count` mods by download count. */
async function ranked(count: number): Promise<string[]> {
	const slugs: string[] = [];
	for (let offset = 0; offset < count; offset += 100) {
		const facets = encodeURIComponent('[["project_type:mod"]]');
		const response = await fetch(`https://api.modrinth.com/v2/search?facets=${facets}&index=downloads&limit=100&offset=${offset}`, { headers: AGENT });
		if (!response.ok) {
			break;
		}
		const body = await response.json() as { hits: Array<{ slug: string; }>; };
		if (body.hits.length === 0) {
			break;
		}
		slugs.push(...body.hits.map(hit => hit.slug));
	}
	return [...new Set(slugs)];
}

/** Newest release on a version we ship a vanilla jar for, on any real loader. */
async function pickRelease(slug: string): Promise<{ version: ModrinthVersion; game: string; } | null> {
	const response = await fetch(`https://api.modrinth.com/v2/project/${slug}/version?limit=100`, { headers: AGENT });
	if (!response.ok) {
		return null;
	}
	const versions = await response.json() as ModrinthVersion[];
	for (const version of versions) {
		const game = SUPPORTED_VERSIONS.find(candidate => version.game_versions.includes(candidate));
		if (game && version.loaders.some(loader => ['neoforge', 'forge', 'fabric'].includes(loader))) {
			return { version, game };
		}
	}
	return null;
}

const args = process.argv.slice(2);
const slugs = args[0] === '--slugs' ? args.slice(1) : await ranked(Number(args[0] ?? 1000));
const catalog = readCatalog();
fs.mkdirSync(MODRINTH_DIR, { recursive: true });

let fetched = 0;
let skipped = 0;
for (const slug of slugs) {
	if (catalog[slug] && fs.existsSync(jarPath(slug))) {
		skipped++;
		continue;
	}
	let release;
	try {
		release = await pickRelease(slug);
	} catch {
		continue;
	}
	if (!release) {
		continue;
	}
	const file = release.version.files.find(entry => entry.primary) ?? release.version.files[0];
	if (!file) {
		continue;
	}
	try {
		const bytes = await fetch(file.url).then(async response => response.arrayBuffer());
		fs.writeFileSync(jarPath(slug), Buffer.from(new Uint8Array(bytes)));
	} catch {
		continue;
	}
	catalog[slug] = { game: release.game, version: release.version.version_number };
	fetched++;
	// Written every time so an interrupted run keeps what it already fetched.
	fs.writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, '\t')}\n`);
}
console.log(`${slugs.length} candidates: ${fetched} fetched, ${skipped} already cached, ${Object.keys(catalog).length} in catalog`);
