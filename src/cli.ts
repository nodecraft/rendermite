#!/usr/bin/env node
/**
 * CLI mirroring renderchest's flag surface, plus what the PHP tool never had:
 * `--version 1.21.8` downloads the client jar, prepares era-appropriate layers
 * (donor geometry, legacy reshaping, bed compat), and picks the right builtin
 * pack — one command from nothing to icons for any version back to 1.2.5.
 */

import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { bedCompatPath, builtinPackPath } from './builtin.ts';
import { curatedModelOverrides } from './mods/models.ts';
import { curatedTintOverrides, harvestTintOverrides } from './mods/tints.ts';
import { JarResourceManager } from './resources/jar.ts';
import { FolderResourceManager, LayeredResourceManager } from './resources/manager.ts';
import { run } from './run.ts';
import { downloadClientJar } from './versions/download.ts';
import {
	type EraName,
	GEOMETRY_DONOR_VERSIONS,
	eraForVersion,
	prepareVersionResources,
} from './versions/prepare.ts';

import type { ResourceManager } from './resources/manager.ts';

const { values } = parseArgs({
	options: {
		'assets': { type: 'string', short: 'a', multiple: true },
		'version': { type: 'string', short: 'v' },
		'mod': { type: 'string', short: 'm', multiple: true },
		'tint-donor': { type: 'string', multiple: true },
		'namespace': { type: 'string', short: 'n', multiple: true },
		'output': { type: 'string', short: 'o' },
		'size': { type: 'string', short: 's', default: '64' },
		'quality': { type: 'string', short: 'q', default: '2' },
		'prefix': { type: 'string', short: 'p', default: 'rc-' },
		'format': { type: 'string', short: 'f', default: 'webp' },
		'fallback': { type: 'boolean', default: false },
		'gif': { type: 'boolean', default: false },
		'avif': { type: 'boolean', default: false },
		'item-list': { type: 'boolean', short: 'i', default: false },
		'lighting-profile': { type: 'string', default: 'modern' },
		'builtin': { type: 'string' },
		'cache-dir': { type: 'string' },
		'concurrency': { type: 'string' },
		'workers': { type: 'string', short: 'w' },
		'help': { type: 'boolean', short: 'h', default: false },
	},
});

const hasInput = Boolean(values.assets?.length || values.version);
if (values.help || !hasInput || !values.output) {
	console.log(`rendermite — Minecraft item icon renderer

Usage:
  rendermite --version <mc version> --output <dir> [options]
  rendermite --assets <dir> [--assets <dir> ...] --output <dir> [options]

Input:
  -v, --version <ver>      download + prepare a vanilla version (1.2.5 … latest)
  -a, --assets <dir>       asset root (repeatable, first wins), <namespace>/ children
  -m, --mod <jar>          mod jar layered under vanilla (repeatable)
      --tint-donor <jar>   1.21.4+ jar of a loaded mod, read for its tints (repeatable)

Options:
  -n, --namespace <ns>     namespace to render (repeatable, default: minecraft)
  -o, --output <dir>       output directory
  -s, --size <px>          icon size (default 64)
  -q, --quality <n>        supersample factor (default 2)
  -p, --prefix <prefix>    CSS class/file prefix (default rc-)
  -f, --format <fmt>       primary image format: webp|avif (default webp)
      --fallback           emit PNG base rules + @media upgrade block
      --gif                also emit animated GIFs for legacy browsers
      --avif               also emit AVIF
  -i, --item-list          write the rendered item id list JSON
      --lighting-profile   modern (default) | legacy (matches published corpus)
      --builtin <dir>      override the builtin pack (defaults per era)
      --cache-dir <dir>    jar download cache (default ~/.rendermite)
      --concurrency <n>    in-flight items per thread (default 8)
  -w, --workers <n>        render threads (default: one per core, less one)
`);
	process.exit(values.help ? 0 : 1);
}

const cacheDir = values['cache-dir'] ?? path.join(os.homedir(), '.rendermite');
let resources: ResourceManager;
let builtin = values.builtin;

if (values.version) {
	const era = eraForVersion(values.version);
	console.log(`Fetching client jar for ${values.version}…`);
	const jar = await downloadClientJar(values.version, cacheDir);
	const donors: Record<string, string> = {};
	const needsDonors = (['preModels', 'legacyFiles', 'legacySheets'] as EraName[]).includes(era);
	if (needsDonors) {
		for (const donor of GEOMETRY_DONOR_VERSIONS) {
			donors[donor] = await downloadClientJar(donor, cacheDir);
		}
	}
	const referenceJar = era === 'legacyFiles' || era === 'legacySheets'
		? await downloadClientJar('1.6.4', cacheDir)
		: undefined;
	resources = await prepareVersionResources({
		version: values.version,
		jar,
		donors,
		referenceJar,
		bedCompat: bedCompatPath(),
	});
	builtin ??= builtinPackPath(era === 'modern' ? 'modern' : 'legacy');
} else {
	const managers: ResourceManager[] = (values.assets ?? []).map(root => new FolderResourceManager(root));
	resources = managers.length === 1 ? managers[0] : new LayeredResourceManager(managers);
	builtin ??= builtinPackPath('modern');
}

if (values['tint-donor']?.length && !values.mod?.length) {
	console.error('--tint-donor needs --mod: donors are read for the tints of loaded mods.');
	process.exit(1);
}

if (values.mod?.length) {
	// Mods layer under vanilla: vanilla wins minecraft:, jars provide their own
	// namespaces and backfill mod-added vanilla paths. Tint layers bracket them —
	// curated above, harvested below (see src/mods/tints.ts).
	const base = new LayeredResourceManager([
		resources,
		curatedTintOverrides(),
		curatedModelOverrides(),
		...values.mod.map(jar => new JarResourceManager(jar)),
	]);
	resources = base;
	if (values['tint-donor']?.length) {
		const donorJars = values['tint-donor'].map(jar => new JarResourceManager(jar));
		const harvest = await harvestTintOverrides({ donors: new LayeredResourceManager(donorJars), target: base });
		await Promise.all(donorJars.map(jar => jar.close().catch(() => {})));
		console.log(`Harvested tints for ${harvest.harvested} items from ${donorJars.length} donor jars`);
		if (harvest.harvested > 0) {
			resources = new LayeredResourceManager([base, harvest.overrides]);
		}
	}
}

const result = await run({
	resources,
	builtin,
	output: values.output,
	namespaces: values.namespace?.length ? values.namespace : undefined,
	size: Number(values.size),
	quality: Number(values.quality),
	prefix: values.prefix,
	format: values.format === 'avif' ? 'avif' : 'webp',
	fallback: values.fallback,
	gif: values.gif,
	avif: values.avif,
	concurrency: values.concurrency ? Number(values.concurrency) : undefined,
	workers: values.workers ? Number(values.workers) : undefined,
	lightingProfile: values['lighting-profile'] === 'legacy' ? 'legacy' : 'modern',
	itemList: values['item-list'],
	onProgress: (done, total, id, error) => {
		if (error) {
			console.error(`Failed ${done}/${total}: ${id} (${error})`);
		} else if (done % 200 === 0 || done === total) {
			console.log(`Rendered ${done}/${total}`);
		}
	},
});

console.log(`\nRendered ${result.rendered.length} items (${result.spriteFallbacks.length} sprite fallbacks), ${result.failed.length} failed, ${result.writtenFiles} files written.`);
if (result.failed.length > 0) {
	process.exitCode = 2;
}
