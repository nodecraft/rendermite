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
import { JarClassReader, layeredClasses } from '../entities/jar-classes.ts';
import { prepareModResources } from '../mods/prepare.ts';
import { FolderResourceManager, LayeredResourceManager } from '../resources/manager.ts';
import { downloadClientJar } from '../versions/download.ts';
import { compareVersions, prepareVersionResources } from '../versions/prepare.ts';

import type { ClassSource } from '../entities/jar-classes.ts';
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
      --no-items           do not export items.json (flat sprites for non-block items)
      --no-entities        do not export entities.json (entity names and marker colours)
      --no-entity-geometry do not read the jar's code for entity model geometry
      --cache-dir <dir>    jar download cache (default ~/.rendermite)
`;

/**
 * The sizes reach the packer directly, where a `NaN` classifies every sprite as
 * oversized and writes an empty atlas — worse than a crash, and only after the
 * jar download and a full export. Checked up front instead.
 */
function parseSizes(padding: string | undefined, maxPageSize: string | undefined): {
	padding?: number;
	maxPageSize?: number;
	errors: string[];
} {
	const errors: string[] = [];
	const size = (raw: string | undefined, flag: string, minimum: number): number | undefined => {
		if (raw === undefined) {
			return undefined;
		}
		const value = Number(raw);
		if (!Number.isSafeInteger(value) || value < minimum) {
			errors.push(`--${flag} must be a whole number of at least ${minimum}; got "${raw}".`);
			return undefined;
		}
		return value;
	};
	return {
		padding: size(padding, 'padding', 0),
		maxPageSize: size(maxPageSize, 'max-page-size', 16),
		errors,
	};
}

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
			'no-items': { type: 'boolean', default: false },
			'no-entities': { type: 'boolean', default: false },
			'no-entity-geometry': { type: 'boolean', default: false },
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

	const sizes = parseSizes(values.padding, values['max-page-size']);
	if (sizes.errors.length > 0) {
		for (const message of sizes.errors) {
			console.error(message);
		}
		return 1;
	}

	const cacheDir = values['cache-dir'] ?? path.join(os.homedir(), '.rendermite');
	let resources: ResourceManager;
	/*
	 * Entity geometry comes out of the *code*, so it needs the jar rather than the resource view of it.
	 * An `--assets` run has none, and exports entity names and colours without shapes.
	 */
	let classes: ClassSource | null = null;
	if (values.version) {
		console.log(`Fetching client jar for ${values.version}…`);
		const jar = await downloadClientJar(values.version, cacheDir);
		resources = await prepareVersionResources({ version: values.version, jar });
		if (!values['no-entity-geometry']) {
			classes = new JarClassReader(jar);
		}
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
		/*
		 * And the mods' *classes*, layered over the client's. A mod writes its models in Java exactly as
		 * the game does, so without this every modded mob came out as a box however good the interpreter
		 * was — and with it, a mod entity can also link to a vanilla model, which many of them are.
		 */
		if (!values['no-entity-geometry']) {
			const modClasses = values.mod.map(jar => new JarClassReader(jar));
			classes = layeredClasses(classes ? [classes, ...modClasses] : modClasses);
		}
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
			padding: sizes.padding,
			maxPageSize: sizes.maxPageSize,
			items: !values['no-items'],
			entities: !values['no-entities'],
			classes: classes ?? undefined,
			cacheDir,
			onProgress: (stage, done, total) => {
				if (done === total || done % 250 === 0) {
					console.log(`${stage}: ${done}/${total}`);
				}
			},
		});
		console.log(`\n${result.blocks} blocks, ${result.models} models, ${result.sprites} sprites across ${result.pages} atlas page(s); ${result.writtenFiles} files written.`);
		console.log(result.items > 0
			? `${result.items} flat items described in items.json.`
			: 'No flat item sprites exported.');
		console.log(result.entities > 0
			? `${result.entities} entity types described in entities.json.`
			: 'No entity types exported.');
		console.log(result.entityModels > 0
			? `${result.entityModels} entity models recovered from the jar's own code.`
			: 'No entity geometry recovered.');
		console.log(result.biomes > 0
			? `${result.biomes} biomes described in biomes.json.`
			: 'No biomes to describe; biomes.json not written.');
		console.log(`${result.failures.length} entries in failures.json.`);
		return 0;
	} finally {
		await closeMods?.();
		await classes?.close();
	}
}
