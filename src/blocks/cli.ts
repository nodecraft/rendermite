/**
 * `rendermite blocks` — the block pack export, mirroring the icon CLI's input
 * handling (download a version's jar, or read asset folders, plus mod jars) but
 * emitting geometry and an atlas instead of icons.
 */

import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { exportBlockPack } from './export.ts';
import { builtinPackPath } from '../builtin.ts';
import { prepareModResources } from '../mods/prepare.ts';
import { FolderResourceManager, LayeredResourceManager } from '../resources/manager.ts';
import { downloadClientJar } from '../versions/download.ts';
import { compareVersions, prepareVersionResources } from '../versions/prepare.ts';

import type { ResourceManager } from '../resources/manager.ts';

/** The Flattening: below it a block is `35:14` and needs a numeric-id table. */
const MINIMUM_VERSION = '1.13';

const HELP = `rendermite blocks — Minecraft block pack export (geometry + atlas, 1.13+)

Usage:
  rendermite blocks --version <mc version> --output <dir> [options]
  rendermite blocks --assets <dir> [--assets <dir> ...] --output <dir> [options]

Input:
  -v, --version <ver>      download + prepare a vanilla version (1.13 … latest)
  -a, --assets <dir>       asset root (repeatable, first wins), <namespace>/ children
  -m, --mod <jar>          mod jar layered under vanilla (repeatable)

Options:
  -n, --namespace <ns>     namespace to export (repeatable, default: minecraft,
                           or every mod namespace when --mod is given)
  -o, --output <dir>       pack directory to write
      --padding <px>       edge-extended sprite border (default 4)
      --max-page-size <px> atlas page ceiling (default 4096)
      --builtin <dir>      override the vendored geometry pack
      --no-builtin         do not substitute geometry for code-drawn blocks
      --cache-dir <dir>    jar download cache (default ~/.rendermite)
`;

export async function runBlocksCli(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			'assets': { type: 'string', short: 'a', multiple: true },
			'version': { type: 'string', short: 'v' },
			'mod': { type: 'string', short: 'm', multiple: true },
			'namespace': { type: 'string', short: 'n', multiple: true },
			'output': { type: 'string', short: 'o' },
			'padding': { type: 'string' },
			'max-page-size': { type: 'string' },
			'cache-dir': { type: 'string' },
			'builtin': { type: 'string' },
			'no-builtin': { type: 'boolean', default: false },
			'help': { type: 'boolean', short: 'h', default: false },
		},
	});

	if (values.help || !values.output || !(values.assets?.length || values.version)) {
		console.log(HELP);
		return values.help ? 0 : 1;
	}
	if (values.version && compareVersions(values.version, MINIMUM_VERSION) < 0) {
		console.error(`Block packs start at ${MINIMUM_VERSION} (the Flattening); ${values.version} needs a numeric-id table that is out of scope.`);
		return 1;
	}

	const cacheDir = values['cache-dir'] ?? path.join(os.homedir(), '.rendermite');
	let resources: ResourceManager;
	if (values.version) {
		console.log(`Fetching client jar for ${values.version}…`);
		resources = await prepareVersionResources({
			version: values.version,
			jar: await downloadClientJar(values.version, cacheDir),
		});
	} else {
		const managers = (values.assets ?? []).map(root => new FolderResourceManager(root));
		resources = managers.length === 1 ? managers[0] : new LayeredResourceManager(managers);
	}

	let namespaces = values.namespace?.length ? values.namespace : ['minecraft'];
	let closeMods: (() => Promise<void>) | null = null;
	if (values.mod?.length) {
		const prepared = await prepareModResources({ jars: values.mod, vanilla: resources });
		resources = prepared.resources;
		closeMods = () => prepared.close();
		for (const { jar, reason } of prepared.rejected) {
			console.error(`Rejected mod jar ${jar}: ${reason}`);
		}
		// Mod packs publish per namespace, so an unqualified modded run exports
		// the mods' namespaces rather than silently exporting vanilla again.
		namespaces = values.namespace?.length ? values.namespace : prepared.namespaces;
	}

	try {
		const result = await exportBlockPack({
			resources,
			// Chests, shulker boxes and signs have no geometry in the assets;
			// this is what gives them one.
			builtin: values['no-builtin'] ? undefined : values.builtin ?? builtinPackPath('modern'),
			output: values.output,
			version: values.version ?? 'custom',
			namespaces,
			padding: values.padding ? Number(values.padding) : undefined,
			maxPageSize: values['max-page-size'] ? Number(values['max-page-size']) : undefined,
			onProgress: (stage, done, total) => {
				if (done === total || done % 250 === 0) {
					console.log(`${stage}: ${done}/${total}`);
				}
			},
		});
		console.log(`\n${result.blocks} blocks, ${result.models} models, ${result.sprites} sprites across ${result.pages} atlas page(s); ${result.writtenFiles} files written.`);
		console.log(`${result.failures.length} entries in failures.json.`);
		return 0;
	} finally {
		await closeMods?.();
	}
}
