import {
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import { ensureVanillaJar } from './fixtures/index.ts';
import { fixtureModJar } from './fixtures/mods.ts';
import { loadAtlasResolver } from '../src/atlas/registry.ts';
import { defaultProperties } from '../src/items/definition.ts';
import { discoverItems, resolveItem } from '../src/items/discovery.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { prepareModResources } from '../src/mods/prepare.ts';
import { blendPixel, toByteTexture } from '../src/render/blend.ts';
import { legacyTintsForChain } from '../src/render/legacy-tints.ts';
import { renderModel } from '../src/render/renderer.ts';
import { resolveTints } from '../src/render/tints.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { TextureLoader } from '../src/textures/loader.ts';
import { prepareVersionResources } from '../src/versions/prepare.ts';

import type { ModPreparation } from '../src/mods/prepare.ts';
import type { FloatTexture } from '../src/render/blend.ts';
import type { Texture } from '../src/textures/loader.ts';

interface ModContext {
	preparation: ModPreparation;
	models: ModelLoader;
	textures: TextureLoader;
}

async function makeContext(jars: string[], vanillaVersion: string): Promise<ModContext> {
	const vanilla = vanillaVersion === '1.7.10'
		? await prepareVersionResources({
			version: '1.7.10',
			jar: await ensureVanillaJar('1.7.10'),
			donors: {
				'1.8.9': await ensureVanillaJar('1.8.9'),
				'1.12.2': await ensureVanillaJar('1.12.2'),
			},
		})
		: new JarResourceManager(await ensureVanillaJar(vanillaVersion));
	const preparation = await prepareModResources({ jars, vanilla });
	const textures = new TextureLoader(preparation.resources);
	textures.setAtlasResolver(await loadAtlasResolver(preparation.resources, locator => textures.load(locator)));
	return { preparation, models: new ModelLoader(preparation.resources), textures };
}

async function renderItem(context: ModContext, id: string): Promise<Texture> {
	const instructions = await resolveItem(context.preparation.resources, id, defaultProperties());
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
			resources: context.preparation.resources,
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

function dominantColor(texture: Texture): [number, number, number] {
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
	return count === 0 ? [0, 0, 0] : [red / count, green / count, blue / count];
}

function hasContent(texture: Texture): boolean {
	for (let offset = 3; offset < texture.data.length; offset += 4) {
		if (texture.data[offset] > 0) {
			return true;
		}
	}
	return false;
}

describe('cross-jar dependencies (depaddon + depcore)', () => {
	let context: ModContext;
	beforeAll(async () => {
		context = await makeContext([fixtureModJar('depaddon'), fixtureModJar('depcore')], '1.20.4');
	});

	it('discovers both namespaces', () => {
		expect(context.preparation.namespaces).toContain('depaddon');
		expect(context.preparation.namespaces).toContain('depcore');
		expect(context.preparation.rejected).toEqual([]);
	});

	it('resolves a model parent living in another jar', async () => {
		const icon = await renderItem(context, 'depaddon:machine');
		expect(hasContent(icon)).toBe(true);
	});

	it('resolves a texture living in another jar', async () => {
		const icon = await renderItem(context, 'depaddon:gadget');
		const [red, green] = dominantColor(icon);
		// core_gear is golden (200, 170, 60).
		expect(red).toBeGreaterThan(150);
		expect(green).toBeGreaterThan(120);
	});

	it('mod-provided vanilla-namespace textures fill gaps under real vanilla', async () => {
		const icon = await renderItem(context, 'depaddon:extra_user');
		const [, green] = dominantColor(icon);
		// depcore_extra is bright green and exists only in the depcore jar.
		expect(green).toBeGreaterThan(100);
	});
});

describe('loader model flattening (loadermod)', () => {
	let context: ModContext;
	beforeAll(async () => {
		context = await makeContext([fixtureModJar('loadermod')], '1.20.4');
	});

	it('forge:composite renders its first child', async () => {
		expect(hasContent(await renderItem(context, 'loadermod:composite_item'))).toBe(true);
	});

	it('separate_transforms prefers the gui perspective', async () => {
		const icon = await renderItem(context, 'loadermod:transforms_item');
		const [red, , blue] = dominantColor(icon);
		// gui_widget is red; the base widget is blue — gui must win.
		expect(red).toBeGreaterThan(blue);
	});

	it('childModel loaders redirect to the named model', async () => {
		expect(hasContent(await renderItem(context, 'loadermod:child_item'))).toBe(true);
	});

	it('fluid containers fall back to the vanilla bucket', async () => {
		expect(hasContent(await renderItem(context, 'loadermod:tank_item'))).toBe(true);
	});

	it('paints bucket contents from the contained fluid', async () => {
		const icon = await renderItem(context, 'loadermod:goop_bucket');
		expect(hasContent(icon)).toBe(true);
		// The goop fill is bright green; a plain bucket is neutral gray.
		let greenish = 0;
		for (let offset = 0; offset < icon.data.length; offset += 4) {
			if (icon.data[offset + 3] > 128 && icon.data[offset + 1] > icon.data[offset] + 40) {
				greenish++;
			}
		}
		expect(greenish).toBeGreaterThan(50);
	});

	it('renders OBJ geometry with MTL material bindings', async () => {
		const icon = await renderItem(context, 'loadermod:obj_item');
		expect(hasContent(icon)).toBe(true);
		// The widget texture is blue — the OBJ's skin must show, not black.
		const [red, , blue] = dominantColor(icon);
		expect(blue).toBeGreaterThan(red);
	});

	it('OBJ models with missing geometry files still fail loudly', async () => {
		await expect(renderItem(context, 'loadermod:broken_obj_item')).rejects.toThrow();
	});

	it('renders OBJ front faces, not the model inside-out', async () => {
		const icon = await renderItem(context, 'loadermod:winding_obj_item');
		const [red, green] = dominantColor(icon);
		// The red top face must be visible; inside-out rendering shows the green bottom.
		expect(red).toBeGreaterThan(green);
	});

	it('salvages models with trailing junk after the JSON', async () => {
		expect(hasContent(await renderItem(context, 'loadermod:junk_item'))).toBe(true);
	});

	it('recurses into composite children that are OBJ loaders', async () => {
		const icon = await renderItem(context, 'loadermod:nested_obj_item');
		expect(hasContent(icon)).toBe(true);
		const [red, , blue] = dominantColor(icon);
		expect(blue).toBeGreaterThan(red);
	});

	it('renders split multiblocks via their inner_model', async () => {
		expect(hasContent(await renderItem(context, 'loadermod:split_item'))).toBe(true);
	});

	it('synthesizes cubes for IE conf_sides models', async () => {
		const icon = await renderItem(context, 'loadermod:conf_item');
		expect(hasContent(icon)).toBe(true);
		// Top (reddish) and side (bluish) faces both visible in the gui view.
		let sawRed = false;
		let sawBlue = false;
		for (let offset = 0; offset < icon.data.length; offset += 4) {
			if (icon.data[offset + 3] < 200) {
				continue;
			}
			if (icon.data[offset] > icon.data[offset + 2] + 30) {
				sawRed = true;
			}
			if (icon.data[offset + 2] > icon.data[offset] + 30) {
				sawBlue = true;
			}
		}
		expect(sawRed).toBe(true);
		expect(sawBlue).toBe(true);
	});

	it('skips faces bound to unresolvable texture variables', async () => {
		expect(hasContent(await renderItem(context, 'loadermod:partial_faces_item'))).toBe(true);
	});

	it('synthesizes a flat belt for IE conveyor loaders', async () => {
		expect(hasContent(await renderItem(context, 'loadermod:belt_item'))).toBe(true);
	});
});

describe('atlas merging across packs (depcore)', () => {
	it('mod paletted_permutations in minecraft:blocks merge with vanilla, not shadow it', async () => {
		const context = await makeContext([fixtureModJar('depcore')], '1.20.4');
		// The mod's permutation must resolve...
		const icon = await renderItem(context, 'depcore:trimmed_gear');
		expect(hasContent(icon)).toBe(true);
		// ...and vanilla's own blocks.json sources must survive the merge (the
		// vanilla jar defines trims/items permutations there for real trims).
		const { ResourceLocator } = await import('../src/resources/locator.ts');
		const vanillaTrim = await context.textures.load(ResourceLocator.parse('minecraft:trims/items/boots_trim_amethyst'));
		expect(vanillaTrim).not.toBeNull();
	});
});

describe('1.21.4+ item definitions in mods (modernmod)', () => {
	let context: ModContext;
	beforeAll(async () => {
		context = await makeContext([fixtureModJar('modernmod')], '1.21.8');
	});

	it('discovers definition-declared items', async () => {
		const discovered = await discoverItems(context.preparation.resources, 'modernmod');
		const ids = discovered.map(item => item.id);
		for (const id of ['modernmod:gizmo', 'modernmod:selector', 'modernmod:grassy', 'modernmod:special_thing', 'modernmod:empty_thing']) {
			expect(ids).toContain(id);
		}
	});

	it('applies constant tints with ARGB values above 2^31', async () => {
		const [red, green, blue] = dominantColor(await renderItem(context, 'modernmod:gizmo'));
		// 0xFFFF0000 over a gray sprite must come out red.
		expect(red).toBeGreaterThan(120);
		expect(green).toBeLessThan(60);
		expect(blue).toBeLessThan(60);
	});

	it('select picks the gui display context', async () => {
		expect(hasContent(await renderItem(context, 'modernmod:selector'))).toBe(true);
	});

	it('grass tints sample the biome colormap with real values', async () => {
		const [red, green] = dominantColor(await renderItem(context, 'modernmod:grassy'));
		expect(green).toBeGreaterThan(red);
	});

	it('specials render their base model instead of nothing', async () => {
		expect(hasContent(await renderItem(context, 'modernmod:special_thing'))).toBe(true);
	});

	it('empty items render transparent', async () => {
		expect(hasContent(await renderItem(context, 'modernmod:empty_thing'))).toBe(false);
	});
});

describe('code-rendered items (geckomod) via run() fallbacks', () => {
	it('renders Bedrock .geo.json geometry, sprite-falls-back, and fails loudly, per item', async () => {
		const { mkdtemp, rm, readFile } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');
		const { default: pathModule } = await import('node:path');
		const { run } = await import('../src/run.ts');
		const { LayeredResourceManager } = await import('../src/resources/manager.ts');

		const { builtinPackPath } = await import('../src/builtin.ts');
		const output = await mkdtemp(pathModule.join(tmpdir(), 'rc-gecko-'));
		try {
			const result = await run({
				resources: new LayeredResourceManager([
					new JarResourceManager(fixtureModJar('geckomod')),
					new JarResourceManager(await ensureVanillaJar('1.20.4')),
				]),
				// 1.20.4 is a legacy-builtin era (the modern pack's templates need newer jars).
				builtin: builtinPackPath('legacy'),
				output,
				namespaces: ['geckomod'],
				itemList: true,
			});
			// beast: real 3D geometry from the geo file, not a fallback.
			expect(result.rendered).toContain('geckomod:beast');
			expect(result.spriteFallbacks).not.toContain('geckomod:beast');
			const beast = await sharpDecode(pathModule.join(output, 'items', 'geckomod', 'beast.png'));
			expect(hasContent(beast)).toBe(true);
			// A 3D render shades faces differently — expect several distinct greens.
			const shades = new Set<number>();
			for (let offset = 0; offset < beast.data.length; offset += 4) {
				if (beast.data[offset + 3] > 128) {
					shades.add(beast.data[offset + 1]);
				}
			}
			expect(shades.size).toBeGreaterThan(1);
			// statue: flat sprite fallback, reported as such.
			expect(result.rendered).toContain('geckomod:statue');
			expect(result.spriteFallbacks).toContain('geckomod:statue');
			// ruby_chest: code-rendered chest mapped onto builtin chest geometry
			// with the mod's own reddish entity texture.
			expect(result.rendered).toContain('geckomod:ruby_chest');
			const chest = await sharpDecode(pathModule.join(output, 'items', 'geckomod', 'ruby_chest.png'));
			expect(hasContent(chest)).toBe(true);
			// creeper_head: mob-name heads use builtin mobheads geometry + vanilla skin.
			expect(result.rendered).toContain('geckomod:creeper_head');
			const head = await sharpDecode(pathModule.join(output, 'items', 'geckomod', 'creeper_head.png'));
			expect(hasContent(head)).toBe(true);
			// parrot_blue_head: variant suffix sheds until the parrot model matches.
			expect(result.rendered).toContain('geckomod:parrot_blue_head');
			// maple_chest / maple_trapped_chest: quark-style per-wood sheets in
			// variant directories — each variant must get its own texture.
			const maple = await sharpDecode(pathModule.join(output, 'items', 'geckomod', 'maple_chest.png'));
			const mapleTrapped = await sharpDecode(pathModule.join(output, 'items', 'geckomod', 'maple_trapped_chest.png'));
			const [, mapleGreen, mapleBlue] = dominantColor(maple);
			expect(mapleGreen).toBeGreaterThan(mapleBlue);
			const [, trappedGreen, trappedBlue] = dominantColor(mapleTrapped);
			expect(trappedBlue).toBeGreaterThan(trappedGreen);
			// beast_spawn_egg: tints derived from the mob's green entity skin.
			expect(result.rendered).toContain('geckomod:beast_spawn_egg');
			const egg = await sharpDecode(pathModule.join(output, 'items', 'geckomod', 'beast_spawn_egg.png'));
			const [eggRed, eggGreen] = dominantColor(egg);
			expect(eggGreen).toBeGreaterThan(eggRed + 20);
			// nested_machine: geo found by directory scan (oritech's layout),
			// texture resolved by mirroring the geo path under textures/.
			expect(result.rendered).toContain('geckomod:nested_machine');
			const machine = await sharpDecode(pathModule.join(output, 'items', 'geckomod', 'nested_machine.png'));
			const [machineRed, machineGreen] = dominantColor(machine);
			expect(machineRed).toBeGreaterThan(machineGreen);
			// Lang-less jars keep the parent-reference template classifier.
			expect(result.skippedTemplates).toContain('geckomod:gecko_template');
			expect(result.rendered).toContain('geckomod:uses_gecko_template');
			// hopeless: nothing to draw → loud failure, present in the sidecar.
			expect(result.failed.map(failure => failure.id)).toContain('geckomod:hopeless');
			const sidecar = JSON.parse(await readFile(pathModule.join(output, 'rc-geckomod-failures.json'), 'utf8')) as Array<{ id: string; }>;
			expect(sidecar.map(failure => failure.id)).toContain('geckomod:hopeless');
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	}, 120000);
});

describe('run() fallback chain (loadermod)', () => {
	it('block-model fallback, dyed variants, and template skipping', async () => {
		const { mkdtemp, rm } = await import('node:fs/promises');
		const { tmpdir } = await import('node:os');
		const { default: pathModule } = await import('node:path');
		const { run } = await import('../src/run.ts');
		const { LayeredResourceManager } = await import('../src/resources/manager.ts');
		const { builtinPackPath } = await import('../src/builtin.ts');

		const output = await mkdtemp(pathModule.join(tmpdir(), 'rc-loader-'));
		try {
			const result = await run({
				resources: new LayeredResourceManager([
					new JarResourceManager(fixtureModJar('loadermod')),
					new JarResourceManager(await ensureVanillaJar('1.20.4')),
				]),
				builtin: builtinPackPath('legacy'),
				output,
				namespaces: ['loadermod'],
				itemList: false,
			});
			// Code-rendered item model + drawable same-name block model → the block.
			expect(result.rendered).toContain('loadermod:machine_thing');
			// Dyed variant of a runtime-generated model → tinted vanilla item_frame.
			expect(result.rendered).toContain('loadermod:red_frame_empty');
			const frame = await sharpDecode(pathModule.join(output, 'items', 'loadermod', 'red_frame_empty.png'));
			const [red, green] = dominantColor(frame);
			expect(red).toBeGreaterThan(green);
			// Key-less templates and state models never even reach rendering: the
			// lang registry gates them out at discovery.
			expect(result.rendered).not.toContain('loadermod:oversized_template');
			expect(result.failed.map(failure => failure.id)).not.toContain('loadermod:oversized_template');
			expect(result.rendered).not.toContain('loadermod:obj_item_pulling_0');
			// Trim variant models are key-less but stay first-class icons.
			expect(result.rendered).toContain('loadermod:machine_thing_copper_trim');
			expect(result.rendered).toContain('loadermod:uses_template');
			// Genuinely broken items still fail loudly.
			expect(result.failed.map(failure => failure.id)).toContain('loadermod:broken_obj_item');
		} finally {
			await rm(output, { recursive: true, force: true });
		}
	}, 120000);
});

async function sharpDecode(file: string): Promise<Texture> {
	const { default: sharp } = await import('sharp');
	const decoded = await sharp(file).ensureAlpha().raw()
		.toBuffer({ resolveWithObject: true });
	return {
		width: decoded.info.width,
		height: decoded.info.height,
		data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length),
	};
}

describe('1.7.10-era texture-only mods (legacymod)', () => {
	let context: ModContext;
	beforeAll(async () => {
		context = await makeContext([fixtureModJar('legacymod')], '1.7.10');
	});

	it('synthesizes item models for plural-dir camelCase textures', async () => {
		const discovered = await discoverItems(context.preparation.resources, 'legacymod');
		const ids = discovered.map(item => item.id);
		expect(ids).toContain('legacymod:cameltool');
		expect(ids).toContain('legacymod:plain_item');
		expect(hasContent(await renderItem(context, 'legacymod:cameltool'))).toBe(true);
	});

	it('synthesizes cube_bottom_top when _top/_side textures exist', async () => {
		const icon = await renderItem(context, 'legacymod:machine');
		expect(hasContent(icon)).toBe(true);
		// The top face (reddish) and side faces (bluish) must both appear.
		let sawRed = false;
		let sawBlue = false;
		for (let offset = 0; offset < icon.data.length; offset += 4) {
			if (icon.data[offset + 3] < 200) {
				continue;
			}
			if (icon.data[offset] > icon.data[offset + 2] + 30) {
				sawRed = true;
			}
			if (icon.data[offset + 2] > icon.data[offset] + 30) {
				sawBlue = true;
			}
		}
		expect(sawRed).toBe(true);
		expect(sawBlue).toBe(true);
	});

	it('synthesizes plain cubes for block textures', async () => {
		expect(hasContent(await renderItem(context, 'legacymod:ore_thing'))).toBe(true);
	});

	it('never invents items from face-suffix textures', async () => {
		const discovered = await discoverItems(context.preparation.resources, 'legacymod');
		const ids = discovered.map(item => item.id);
		expect(ids).not.toContain('legacymod:frame_overlay');
	});
});
