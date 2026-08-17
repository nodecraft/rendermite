/**
 * Curated geometry (`assets/mod-models/`) exists so code-drawn `builtin/entity`
 * mod items render at all. It only works if it sits ABOVE the caller's tree:
 * layers resolve first-hit, and the mod's own stub occupies the same path.
 *
 * `cli.ts` layers it explicitly, but callers that pass an assembled pack instead
 * of jars go straight to `run()`. That path silently lost every curated item —
 * each one failing as "Unsupported builtin parent builtin/entity", indistinguishable
 * from a mod we genuinely cannot draw, so it never showed up as a regression.
 */

import {
	mkdir,
	mkdtemp,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import { ensureVanillaJar } from './fixtures/index.ts';
import { builtinPackPath } from '../src/builtin.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { curatedModelOverrides } from '../src/mods/models.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { FolderResourceManager, LayeredResourceManager } from '../src/resources/manager.ts';
import { run } from '../src/run.ts';

import type { RunResult } from '../src/run.ts';

const builtin = builtinPackPath('modern');

/** The display-transforms-only stub Mekanism ships; the boxes live in a Java class. */
const STUB = {
	parent: 'builtin/entity',
	display: { gui: { rotation: [90, 45, 270], translation: [2, 1.5, 0], scale: [0.525, 0.525, 0.525] } },
};

describe('curated mod geometry reaches run()', () => {
	let assets: string;
	let output: string;
	let result: RunResult;

	beforeAll(async () => {
		assets = await mkdtemp(path.join(tmpdir(), 'rendermite-curated-assets-'));
		output = await mkdtemp(path.join(tmpdir(), 'rendermite-curated-out-'));

		// An assembled pack, the way the icon pipeline passes one: the mod's stub
		// model is present, so a layer placed below it would never be consulted.
		await mkdir(path.join(assets, 'mekanism', 'models', 'item'), { recursive: true });
		await writeFile(
			path.join(assets, 'mekanism', 'models', 'item', 'atomic_disassembler.json'),
			JSON.stringify(STUB),
		);
		// The curated model names this texture but does not ship it — it comes from
		// the mod, under textures/render/, which is easy to miss when assembling a pack.
		await mkdir(path.join(assets, 'mekanism', 'textures', 'render'), { recursive: true });
		await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 90, g: 160, b: 90, alpha: 1 } } })
			.png()
			.toFile(path.join(assets, 'mekanism', 'textures', 'render', 'atomic_disassembler.png'));

		result = await run({
			// In-process: test files run in parallel and a pool each would starve them.
			workers: 1,
			resources: new LayeredResourceManager([
				new FolderResourceManager(assets),
				new JarResourceManager(await ensureVanillaJar('1.21.8')),
			]),
			builtin,
			output,
			namespaces: ['mekanism'],
			// The pack carries no lang file; its models are already registry-filtered.
			filterUntranslatedModels: false,
			size: 64,
			itemList: true,
		});
	}, 240000);

	afterAll(async () => {
		await rm(assets, { recursive: true, force: true });
		await rm(output, { recursive: true, force: true });
	});

	it('renders a code-drawn item whose only model in the pack is a builtin/entity stub', () => {
		expect(result.failed).toEqual([]);
		expect(result.rendered).toContain('mekanism:atomic_disassembler');
	});

	it('draws the curated geometry, not a flat sprite fallback', () => {
		// A sprite fallback would also land in `rendered`, so success alone proves
		// nothing about which path drew it.
		expect(result.spriteFallbacks).not.toContain('mekanism:atomic_disassembler');
	});

	it('resolves curated geometry over a stub at the same path', async () => {
		const locator = ResourceLocator.parse('mekanism:item/atomic_disassembler');
		const pack = new FolderResourceManager(assets);

		const stubOnly = await new ModelLoader(pack).load(locator);
		expect(stubOnly.elements).toHaveLength(0);

		// Curated first, mirroring run(). Reversing these is the actual bug: the
		// stub wins, every curated item fails, and nothing distinguishes it from
		// a mod we cannot draw.
		const above = await new ModelLoader(new LayeredResourceManager([curatedModelOverrides(), pack])).load(locator);
		expect(above.elements.length).toBeGreaterThan(0);

		const below = await new ModelLoader(new LayeredResourceManager([pack, curatedModelOverrides()])).load(locator);
		expect(below.elements).toHaveLength(0);
	});
});
