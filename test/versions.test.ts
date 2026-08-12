import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadAtlasResolver } from '../src/atlas/registry.ts';
import { bedCompatPath, builtinPackPath } from '../src/builtin.ts';
import { builtinDynamicResources } from '../src/dynamic/generators.ts';
import { defaultProperties } from '../src/items/definition.ts';
import { discoverItems, resolveItem } from '../src/items/discovery.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { blendPixel, toByteTexture } from '../src/render/blend.ts';
import { legacyTintsForChain } from '../src/render/legacy-tints.ts';
import { renderModel } from '../src/render/renderer.ts';
import { resolveTints } from '../src/render/tints.ts';
import { FolderResourceManager, LayeredResourceManager } from '../src/resources/manager.ts';
import { TextureLoader } from '../src/textures/loader.ts';
import { eraForVersion, prepareVersionResources } from '../src/versions/prepare.ts';

import type { FloatTexture } from '../src/render/blend.ts';
import type { ResourceManager } from '../src/resources/manager.ts';
import type { Texture } from '../src/textures/loader.ts';

const fixtures = path.join(import.meta.dirname, '..', '.work', 'fixtures');
const goldenRoot = path.join(import.meta.dirname, '..', '.work', 'golden');

const jar = (version: string) => path.join(fixtures, `${version}-client.jar`);
const DONORS = { '1.8.9': jar('1.8.9'), '1.12.2': jar('1.12.2') };

interface VersionCase {
	version: string;
	/** Fraction of the corpus item list we must be able to render. */
	coverageFloor: number;
	/** Items whose icons must come out non-empty. */
	mustRender: string[];
	/** id → [x, y, predicate] color expectations (tint checks). */
	colorChecks?: Array<{ id: string; check: (rgba: [number, number, number, number]) => boolean; label: string; }>;
}

function greenish([red, green, blue, alpha]: [number, number, number, number]): boolean {
	return alpha > 0 && green > red && green > blue && green > 60;
}

const CASES: VersionCase[] = [
	{
		// Newest stable, new 26.x version scheme: 1,538 items/ definitions with
		// nested special renderer types (copper chests, mannequin, nautilus).
		version: '26.2',
		coverageFloor: 0.95,
		mustRender: ['minecraft:copper_chest', 'minecraft:stone', 'minecraft:crossbow', 'minecraft:bundle', 'minecraft:copper_golem_statue'],
		colorChecks: [
			{ id: 'minecraft:grass_block', check: greenish, label: 'grass top tinted green' },
			{ id: 'minecraft:oak_leaves', check: greenish, label: 'leaves tinted green' },
		],
	},
	{
		// 26.1: beds are composites of specials whose base still chains to
		// template_bed — the bed-compat layer must cover this version too.
		version: '26.1.2',
		coverageFloor: 0.95,
		mustRender: ['minecraft:copper_chest', 'minecraft:stone', 'minecraft:red_bed', 'minecraft:copper_golem_statue'],
		colorChecks: [{ id: 'minecraft:grass_block', check: greenish, label: 'grass top tinted green' }],
	},
	{
		version: '1.21.11',
		coverageFloor: 0.97,
		mustRender: ['minecraft:copper_chest', 'minecraft:stone', 'minecraft:spyglass', 'minecraft:red_bed'],
	},
	{
		// The 1.21.4 boundary: first release with items/ definitions.
		version: '1.21.4',
		coverageFloor: 0.97,
		mustRender: ['minecraft:stone', 'minecraft:diamond_sword', 'minecraft:crossbow', 'minecraft:leather_chestplate', 'minecraft:red_bed'],
		colorChecks: [{ id: 'minecraft:grass_block', check: greenish, label: 'grass top tinted green' }],
	},
	{
		// Last of the models/item discovery era.
		version: '1.21.1',
		coverageFloor: 0.97,
		mustRender: ['minecraft:stone', 'minecraft:mace', 'minecraft:trial_key'],
		colorChecks: [{ id: 'minecraft:grass_block', check: greenish, label: 'grass top tinted green' }],
	},
	{
		version: '1.20.4',
		coverageFloor: 0.97,
		mustRender: ['minecraft:stone', 'minecraft:diamond_sword', 'minecraft:oak_stairs', 'minecraft:creeper_spawn_egg'],
		colorChecks: [
			{ id: 'minecraft:grass_block', check: greenish, label: 'grass top tinted green' },
			{ id: 'minecraft:oak_leaves', check: greenish, label: 'leaves tinted green' },
		],
	},
	{
		// Armor trims arrive: paletted_permutations atlases.
		version: '1.19.4',
		coverageFloor: 0.95,
		mustRender: ['minecraft:stone', 'minecraft:cherry_boat', 'minecraft:brush'],
	},
	{
		version: '1.18.2',
		coverageFloor: 0.95,
		mustRender: ['minecraft:stone', 'minecraft:spyglass'],
	},
	{
		version: '1.17.1',
		coverageFloor: 0.95,
		mustRender: ['minecraft:stone', 'minecraft:amethyst_shard'],
	},
	{
		version: '1.16.5',
		coverageFloor: 0.97,
		mustRender: ['minecraft:netherite_sword', 'minecraft:crimson_stem', 'minecraft:stone'],
		colorChecks: [{ id: 'minecraft:grass_block', check: greenish, label: 'grass top tinted green' }],
	},
	{
		version: '1.15.2',
		coverageFloor: 0.95,
		mustRender: ['minecraft:stone', 'minecraft:honey_bottle'],
	},
	{
		version: '1.14.4',
		coverageFloor: 0.95,
		mustRender: ['minecraft:stone', 'minecraft:crossbow'],
	},
	{
		// First release after the Flattening: modern ids, per-color items.
		version: '1.13.2',
		coverageFloor: 0.9,
		mustRender: ['minecraft:stone', 'minecraft:red_wool', 'minecraft:trident'],
	},
	{
		version: '1.12.2',
		coverageFloor: 0.9,
		mustRender: ['minecraft:stone', 'minecraft:diamond_sword'],
		colorChecks: [{ id: 'minecraft:grass', check: greenish, label: 'grass block tinted green' }],
	},
	{
		version: '1.11.2',
		coverageFloor: 0.9,
		mustRender: ['minecraft:stone', 'minecraft:shulker_shell'],
	},
	{
		version: '1.10.2',
		coverageFloor: 0.9,
		mustRender: ['minecraft:stone', 'minecraft:diamond_sword'],
	},
	{
		version: '1.9.4',
		coverageFloor: 0.9,
		mustRender: ['minecraft:stone', 'minecraft:elytra'],
	},
	{
		version: '1.8.9',
		coverageFloor: 0.9,
		mustRender: ['minecraft:stone', 'minecraft:diamond_sword'],
	},
	{
		version: '1.7.10',
		coverageFloor: 0.75,
		mustRender: ['minecraft:stone', 'minecraft:diamond_sword'],
	},
	{
		// Donor-geometry era with the 1.6 assets layout.
		version: '1.6.4',
		coverageFloor: 0.75,
		mustRender: ['minecraft:stone', 'minecraft:diamond_sword'],
	},
	{
		version: '1.5.2',
		coverageFloor: 0.6,
		mustRender: ['minecraft:stone', 'minecraft:diamond_sword'],
	},
	{
		version: '1.4.7',
		coverageFloor: 0.5,
		mustRender: ['minecraft:stone'],
	},
	{
		// Oldest corpus-supported release: stitched terrain.png era.
		version: '1.2.5',
		coverageFloor: 0.45,
		mustRender: ['minecraft:stone'],
	},
];

async function corpusItemList(version: string): Promise<string[] | null> {
	const dir = path.join(goldenRoot, version);
	const file = path.join(dir, 'rc-minecraft.json');
	if (!existsSync(file)) {
		await mkdir(dir, { recursive: true });
		const response = await fetch(`https://mc-assets.nodecraft.com/icons/${version}/rc-minecraft.json`);
		if (!response.ok) {
			return null;
		}
		await writeFile(file, Buffer.from(await response.arrayBuffer()));
	}
	const list = JSON.parse(await readFile(file, 'utf8')) as string[];
	return list.filter(id => id.startsWith('minecraft:'));
}

interface VersionContext {
	resources: ResourceManager;
	models: ModelLoader;
	textures: TextureLoader;
}

const contexts = new Map<string, Promise<VersionContext>>();

function contextFor(version: string): Promise<VersionContext> {
	let pending = contexts.get(version);
	if (!pending) {
		pending = (async () => {
			const era = eraForVersion(version);
			let resources = await prepareVersionResources({
				version,
				jar: jar(version),
				donors: DONORS,
				referenceJar: era === 'legacyFiles' || era === 'legacySheets' ? jar('1.6.4') : undefined,
				bedCompat: bedCompatPath(),
			});
			const builtinPack = builtinPackPath(era === 'modern' ? 'modern' : 'legacy');
			resources = new LayeredResourceManager([
				new FolderResourceManager(builtinPack),
				builtinDynamicResources().layer,
				resources,
			]);
			const textures = new TextureLoader(resources);
			textures.setAtlasResolver(await loadAtlasResolver(resources, locator => textures.load(locator)));
			return { resources, models: new ModelLoader(resources), textures };
		})();
		contexts.set(version, pending);
	}
	return pending;
}

async function renderItem(context: VersionContext, id: string): Promise<Texture> {
	const instructions = await resolveItem(context.resources, id, defaultProperties());
	let combined: FloatTexture | null = null;
	for (const instruction of instructions) {
		const model = await context.models.load(instruction.model);
		const tints = instruction.tints.length > 0
			? await resolveTints(instruction.tints, { textures: context.textures })
			: await legacyTintsForChain(model.chain, context.textures) ?? [];
		const rendered = await renderModel(model, context.textures, {
			size: 64,
			quality: 2,
			lightingProfile: 'modern',
			itemTransform: instruction.transform,
			tints,
			resources: context.resources,
		});
		if (combined === null) {
			combined = rendered;
		} else {
			for (let offset = 0; offset < combined.data.length; offset += 4) {
				const alpha = rendered.data[offset + 3];
				if (alpha > 0) {
					blendPixel(combined.data, offset, rendered.data[offset], rendered.data[offset + 1], rendered.data[offset + 2], alpha);
				}
			}
		}
	}
	return toByteTexture(combined ?? { width: 64, height: 64, data: new Float64Array(64 * 64 * 4) });
}

function hasContent(texture: Texture): boolean {
	for (let offset = 3; offset < texture.data.length; offset += 4) {
		if (texture.data[offset] > 0) {
			return true;
		}
	}
	return false;
}

function isAllBlack(texture: Texture): boolean {
	let opaque = 0;
	let black = 0;
	for (let offset = 0; offset < texture.data.length; offset += 4) {
		if (texture.data[offset + 3] <= 128) {
			continue;
		}

		opaque++;
		if (texture.data[offset] < 12 && texture.data[offset + 1] < 12 && texture.data[offset + 2] < 12) {
			black++;
		}
	}
	return opaque > 0 && black / opaque > 0.95;
}

/** Dominant opaque color, ignoring near-black outline pixels. */
function dominantColor(texture: Texture): [number, number, number, number] {
	let red = 0;
	let green = 0;
	let blue = 0;
	let count = 0;
	for (let offset = 0; offset < texture.data.length; offset += 4) {
		if (texture.data[offset + 3] <= 128) {
			continue;
		}

		red += texture.data[offset];
		green += texture.data[offset + 1];
		blue += texture.data[offset + 2];
		count++;
	}
	if (count === 0) {
		return [0, 0, 0, 0];
	}
	return [red / count, green / count, blue / count, 255];
}

describe.each(CASES.filter(entry => existsSync(jar(entry.version))))('version $version', ({ version, coverageFloor, mustRender, colorChecks }) => {
	it('discovers and renders the corpus item set', async () => {
		const context = await contextFor(version);
		const discovered = await discoverItems(context.resources, 'minecraft');
		expect(discovered.length).toBeGreaterThan(100);

		const corpus = await corpusItemList(version);
		const sample = corpus ?? discovered.map(item => item.id);
		let rendered = 0;
		let failed = 0;
		const failures: string[] = [];
		// Every 5th item keeps runtime sane while still sweeping broadly.
		const step = Math.max(1, Math.floor(sample.length / 250));
		for (let i = 0; i < sample.length; i += step) {
			const id = sample[i];
			try {
				const icon = await renderItem(context, id);
				if (hasContent(icon) && !isAllBlack(icon)) {
					rendered++;
				} else {
					failed++;
					if (failures.length < 12) {
						failures.push(`${id} (${hasContent(icon) ? 'all black' : 'empty'})`);
					}
				}
			} catch (err) {
				failed++;
				if (failures.length < 12) {
					failures.push(`${id} (${(err as Error).message.slice(0, 60)})`);
				}
			}
		}
		const coverage = rendered / (rendered + failed);
		expect(coverage, `coverage ${(coverage * 100).toFixed(1)}% — sample failures: ${failures.join('; ')}`).toBeGreaterThanOrEqual(coverageFloor);
	}, 240000);

	it('renders the must-have items', async () => {
		const context = await contextFor(version);
		for (const id of mustRender) {
			const icon = await renderItem(context, id);
			expect(hasContent(icon), `${id} should render non-empty`).toBe(true);
			expect(isAllBlack(icon), `${id} should not be a black square`).toBe(false);
		}
	}, 120000);

	if (colorChecks?.length) {
		it('applies tints', async () => {
			const context = await contextFor(version);
			for (const { id, check, label } of colorChecks) {
				const icon = await renderItem(context, id);
				const color = dominantColor(icon);
				expect(check(color), `${label} (${id} dominant rgba ${color.map(channel => Math.round(channel)).join(',')})`).toBe(true);
			}
		}, 120000);
	}
});
