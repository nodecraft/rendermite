/**
 * The curated mod-geometry pack and the two element extensions it needs
 * (`emissive_rc`, `alpha_rc`). The Mekanism case renders a real jar downloaded at
 * test time; set RENDERMITE_SKIP_ONLINE=1 to skip it.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ensureModrinthJar, ensureVanillaJar } from './fixtures/index.ts';
import { modModelPackPath } from '../src/builtin.ts';
import { defaultProperties } from '../src/items/definition.ts';
import { resolveItem } from '../src/items/discovery.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { curatedModelOverrides } from '../src/mods/models.ts';
import { prepareModResources } from '../src/mods/prepare.ts';
import { toByteTexture } from '../src/render/blend.ts';
import { renderModel } from '../src/render/renderer.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { FolderResourceManager } from '../src/resources/manager.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { TextureLoader } from '../src/textures/loader.ts';

import type { ModelElementJson } from '../src/models/types.ts';
import type { ResourceManager } from '../src/resources/manager.ts';

async function pixel(red: number, green: number, blue: number, alpha = 255): Promise<Buffer> {
	return sharp({ create: { width: 1, height: 1, channels: 4, background: { r: red, g: green, b: blue, alpha: alpha / 255 } } })
		.png()
		.toBuffer();
}

/** A single full-block cube, so every render samples the one flat colour. */
function cubeModel(element: Partial<ModelElementJson>): unknown {
	return {
		gui_light: 'side',
		textures: { texture: 'test:block/flat' },
		display: { gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
		elements: [{
			from: [0, 0, 0],
			to: [16, 16, 16],
			faces: Object.fromEntries(
				['down', 'up', 'north', 'south', 'west', 'east'].map(name => [name, { texture: '#texture' }]),
			),
			...element,
		}],
	};
}

async function renderCube(element: Partial<ModelElementJson>): Promise<{ colors: Set<string>; alphas: Set<number>; faceAlpha: number; }> {
	const resources = new MapResourceManager()
		.set('texture', 'test:block/flat', await pixel(200, 100, 50))
		.set('model', 'test:item/cube', JSON.stringify(cubeModel(element)));
	const textures = new TextureLoader(resources);
	const model = await new ModelLoader(resources).load(ResourceLocator.parse('test:item/cube'));
	const rendered = toByteTexture(await renderModel(model, textures, {
		size: 32,
		quality: 1,
		lightingProfile: 'modern',
		tints: [],
		resources,
	}));

	const colors = new Set<string>();
	const counts = new Map<number, number>();
	for (let offset = 0; offset < rendered.data.length; offset += 4) {
		const alpha = rendered.data[offset + 3];
		if (alpha === 0) {
			continue;
		}
		counts.set(alpha, (counts.get(alpha) ?? 0) + 1);
		colors.add(`${rendered.data[offset]},${rendered.data[offset + 1]},${rendered.data[offset + 2]}`);
	}
	// Adjacent cube faces both rasterize their shared edge, so edge pixels blend
	// twice; the modal alpha is the one a single face actually contributes.
	const faceAlpha = [...counts].reduce((best, entry) => (entry[1] > best[1] ? entry : best))[0];
	return { colors, alphas: new Set(counts.keys()), faceAlpha };
}

describe('element render extensions', () => {
	it('shades each visible face differently by default', async () => {
		const { colors, faceAlpha } = await renderCube({});
		// Three faces of a cube face the camera, each at its own light level.
		expect(colors.size).toBe(3);
		expect(faceAlpha).toBe(255);
	});

	it('emissive_rc drops directional shading, leaving the texture colour', async () => {
		const { colors, alphas } = await renderCube({ emissive_rc: true });
		expect([...colors]).toEqual(['200,100,50']);
		expect([...alphas]).toEqual([255]);
	});

	it('alpha_rc scales opacity without touching colour', async () => {
		const { colors, faceAlpha } = await renderCube({ emissive_rc: true, alpha_rc: 0.5 });
		expect([...colors]).toEqual(['200,100,50']);
		expect(faceAlpha).toBe(127);
	});

	it('clamps an out-of-range alpha_rc rather than producing a hole', async () => {
		const { alphas } = await renderCube({ emissive_rc: true, alpha_rc: 4 });
		expect([...alphas]).toEqual([255]);
	});

	it('leaves shading alone when the extensions are absent', async () => {
		const plain = await renderCube({});
		const explicit = await renderCube({ emissive_rc: false, alpha_rc: 1 });
		expect(explicit.colors).toEqual(plain.colors);
	});
});

describe('curated model overrides', () => {
	it('holds only item models, one namespace directory per mod', async () => {
		const pack = new FolderResourceManager(modModelPackPath());
		const namespaces = await pack.listNamespaces();
		expect(namespaces).toContain('mekanism');
		for (const namespace of namespaces) {
			const entries = await pack.listResources('model', namespace);
			expect(entries.length).toBeGreaterThan(0);
		}
	});

	it.each([
		['botania:avatar', 6],
		['botania:bellows', 4],
		['botania:teru_teru_bozu', 3],
		['botania:brewery', 10],
		['botania:hourglass', 5],
		['botania:corporea_index', 3],
		['botania:mana_pylon', 8],
		['botania:natura_pylon', 12],
		['botania:gaia_pylon', 12],
	])('ports %s out of its Java model', async (id, elements) => {
		const models = new ModelLoader(curatedModelOverrides());
		const locator = ResourceLocator.parse(id);
		const model = await models.load(new ResourceLocator(locator.namespace, `item/${locator.path}`));
		expect(model.display.gui).toBeDefined();
		expect(model.elements).toHaveLength(elements);
	});

	it.each([
		['atomic_disassembler', 16],
		['flamethrower', 23],
		['scuba_tank', 9],
		['free_runners', 6],
		['jetpack', 21],
		['scuba_mask', 28],
	])('restates %s with its display transforms, replacing the jar model outright', async (item, elements) => {
		const models = new ModelLoader(curatedModelOverrides());
		const model = await models.load(ResourceLocator.parse(`mekanism:item/${item}`));
		expect(model.display.gui).toBeDefined();
		expect(model.elements).toHaveLength(elements);
		// Every element carries the ISTER's 180° flip as its outermost Z term.
		for (const element of model.elements) {
			expect(element.rotation?.origin).toBeDefined();
			expect(Math.abs((element.rotation as unknown as { z: number; }).z)).toBeGreaterThanOrEqual(135);
		}
	});

	/**
	 * Mekanism's own ModelScubaMask puts mouthIntake at texOffs(118, 42) with
	 * w=3/d=3, so its back face unwraps to u=130 on a 128px sheet and samples the
	 * clamped edge in-game. Listed rather than clamped: the face is buried inside
	 * the mask, and "fixing" it would stop matching what the game draws. Any
	 * other overrun means the extractor read a box wrong.
	 */
	const KNOWN_UV_OVERRUNS = new Set(['scuba_mask/mouthIntake/south']);

	it('keeps UVs inside the sheet apart from the mod\'s own known overrun', async () => {
		const models = new ModelLoader(curatedModelOverrides());
		const overruns = new Set<string>();
		for (const item of ['atomic_disassembler', 'flamethrower', 'scuba_tank', 'free_runners', 'jetpack', 'scuba_mask']) {
			const model = await models.load(ResourceLocator.parse(`mekanism:item/${item}`));
			for (const element of model.elements) {
				for (const [direction, face] of Object.entries(element.faces)) {
					if ((face?.uv ?? []).some(value => value < 0 || value > 16)) {
						overruns.add(`${item}/${(element as unknown as { name: string; }).name}/${direction}`);
					}
				}
			}
		}
		expect([...overruns].toSorted((left, right) => left.localeCompare(right))).toEqual([...KNOWN_UV_OVERRUNS]);
	});
});

const online = process.env.RENDERMITE_SKIP_ONLINE !== '1';

describe.runIf(online)('mekanism:atomic_disassembler', () => {
	// One preparation for the whole block: each call opens jar handles that
	// ModPreparation gives no way to close.
	let shared: Promise<ResourceManager> | null = null;
	const mekanism = (): Promise<ResourceManager> => {
		shared ??= (async () => {
			const preparation = await prepareModResources({
				jars: [await ensureModrinthJar({ slug: 'mekanism', gameVersion: '1.21.1', loader: 'neoforge' })],
				vanilla: new JarResourceManager(await ensureVanillaJar('1.21.1')),
			});
			return preparation.resources;
		})();
		return shared;
	};

	it('renders the ported Java model instead of failing on builtin/entity', async () => {
		const resources = await mekanism();
		const textures = new TextureLoader(resources);
		const models = new ModelLoader(resources);

		const instructions = await resolveItem(resources, 'mekanism:atomic_disassembler', defaultProperties());
		expect(instructions).toHaveLength(1);
		const model = await models.load(instructions[0].model);
		// The jar's own model is a bare builtin/entity stub; the override wins.
		expect(model.builtinParent).toBeNull();
		expect(model.elements).toHaveLength(16);

		const rendered = toByteTexture(await renderModel(model, textures, {
			size: 64,
			quality: 4,
			lightingProfile: 'modern',
			itemTransform: instructions[0].transform,
			tints: [],
			resources,
		}));

		let opaqueBody = 0;
		let translucentBlade = 0;
		for (let offset = 0; offset < rendered.data.length; offset += 4) {
			const [red, green, blue, alpha] = rendered.data.slice(offset, offset + 4);
			if (alpha === 0) {
				continue;
			}
			if (alpha === 255) {
				opaqueBody++;
			}
			// The sheet's blade cyan, surviving unshaded because the part is emissive.
			if (red === 0 && green === 216 && blue === 255 && alpha < 255) {
				translucentBlade++;
			}
		}
		expect(opaqueBody).toBeGreaterThan(0);
		expect(translucentBlade).toBeGreaterThan(0);
	}, 120000);

	it.each([
		'flamethrower',
		'scuba_tank',
		'free_runners',
		'jetpack',
		'scuba_mask',
	])('renders %s instead of failing on builtin/entity', async (item) => {
		const resources = await mekanism();
		const textures = new TextureLoader(resources);
		const models = new ModelLoader(resources);
		const [instruction] = await resolveItem(resources, `mekanism:${item}`, defaultProperties());
		const model = await models.load(instruction.model);
		expect(model.builtinParent).toBeNull();

		const rendered = toByteTexture(await renderModel(model, textures, {
			size: 64,
			quality: 2,
			lightingProfile: 'modern',
			itemTransform: instruction.transform,
			tints: [],
			resources,
		}));
		let painted = 0;
		for (let offset = 3; offset < rendered.data.length; offset += 4) {
			if (rendered.data[offset] > 0) {
				painted++;
			}
		}
		// A geometry or UV slip shows up as a near-empty icon, not an exception.
		expect(painted).toBeGreaterThan(300);
	}, 120000);

	it('reads the entity sheet from render/, outside textures/', async () => {
		const textures = new TextureLoader(await mekanism());
		const sheet = await textures.load(ResourceLocator.parse('mekanism:render/atomic_disassembler'));
		expect(sheet).not.toBeNull();
		expect([sheet!.width, sheet!.height]).toEqual([64, 32]);
	}, 120000);
});

describe.runIf(online)('botania block-entity items', () => {
	// Botania has no item renderer of its own: TEISR hands the stack to the
	// block's BlockEntityRenderer, so these poses are that renderer's.
	let shared: Promise<ResourceManager> | null = null;
	const botania = (): Promise<ResourceManager> => {
		shared ??= (async () => {
			const preparation = await prepareModResources({
				jars: [await ensureModrinthJar({ slug: 'botania', gameVersion: '1.20.1', loader: 'forge' })],
				vanilla: new JarResourceManager(await ensureVanillaJar('1.20.1')),
			});
			return preparation.resources;
		})();
		return shared;
	};

	it.each([
		'avatar',
		'bellows',
		'teru_teru_bozu',
		'brewery',
		'hourglass',
		'corporea_index',
		'mana_pylon',
		'natura_pylon',
		'gaia_pylon',
	])('renders %s instead of failing on builtin/entity', async (item) => {
		const resources = await botania();
		const textures = new TextureLoader(resources);
		const models = new ModelLoader(resources);
		const [instruction] = await resolveItem(resources, `botania:${item}`, defaultProperties());
		const model = await models.load(instruction.model);
		expect(model.builtinParent).toBeNull();

		const rendered = toByteTexture(await renderModel(model, textures, {
			size: 64,
			quality: 2,
			lightingProfile: 'modern',
			itemTransform: instruction.transform,
			tints: [],
			resources,
		}));
		let painted = 0;
		for (let offset = 3; offset < rendered.data.length; offset += 4) {
			if (rendered.data[offset] > 0) {
				painted++;
			}
		}
		expect(painted).toBeGreaterThan(300);
	}, 180000);
});
