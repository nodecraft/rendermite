/**
 * The mod-shaped cases the vanilla matrix never exercises, driven from
 * synthetic assets so each one is isolated: OBJ geometry, a stated render
 * layer, an arbitrary element angle, a third rotation axis, and the three ways
 * a mod's assets can be broken without the pack losing the block.
 *
 * Every one of these came out of exporting the real mod corpus; the mod that
 * motivated each is named on the case.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import {
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import { exportBlockPack } from '../src/blocks/export.ts';
import { builtinPackPath } from '../src/builtin.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

interface Pack {
	models: Record<string, {
		ao: boolean;
		elements: Array<{ rotation?: { angle: number; }; faces: Record<string, { sprite: string; uv: number[]; }>; }>;
		mesh?: Array<{ sprite: string; object?: string; positions: number[]; uv: number[]; }>;
		particle?: string;
		renderType?: string;
		multiblock?: number[][];
		fluid?: { still: string; flow: string; overlay?: string; };
	}>;
	blockStates: Record<string, {
		variants?: Array<{ when: Record<string, string>; apply: Array<{ model: string; y?: number; z?: number; }>; }>;
		multipart?: Array<{ when: unknown; apply: Array<{ model: string; }>; }>;
	}>;
	sprites: Record<string, { layer: string; }>;
	failures: Array<{ id: string; kind: string; reason: string; }>;
}

const outRoot = path.join(import.meta.dirname, '..', '.work', 'block-packs', 'mods');

let solidPng: Buffer;
let holedPng: Buffer;

beforeAll(async () => {
	solidPng = await sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 90, g: 120, b: 60, alpha: 1 } } })
		.png()
		.toBuffer();
	// Half transparent, half opaque: cutout by inference, so a stated render
	// type disagreeing with it is visible in the assertions.
	const pixels = Buffer.alloc(16 * 16 * 4);
	for (let index = 0; index < 16 * 16; index++) {
		pixels.set([200, 40, 40, index % 2 === 0 ? 0 : 255], index * 4);
	}
	holedPng = await sharp(pixels, { raw: { width: 16, height: 16, channels: 4 } }).png().toBuffer();
});

/** With `substitute`, the vendored pack is layered in so code-drawn blocks are swapped. */
async function exportFrom(
	name: string,
	build: (resources: MapResourceManager) => void,
	substitute = false,
): Promise<Pack> {
	const resources = new MapResourceManager();
	resources.set('texture', 'example:block/plain', solidPng);
	resources.set('texture', 'example:block/holed', holedPng);
	build(resources);
	const output = path.join(outRoot, name);
	const result = await exportBlockPack({
		resources,
		output,
		version: 'test',
		namespaces: ['example'],
		builtin: substitute ? builtinPackPath('modern') : undefined,
	});
	const read = async <T>(file: string): Promise<T> => JSON.parse(await readFile(path.join(output, file), 'utf8')) as T;
	const atlas = await read<{ sprites: Pack['sprites']; }>('atlas.json');
	return {
		models: await read<Pack['models']>('models.json'),
		blockStates: await read<Pack['blockStates']>('blockstates.json'),
		sprites: atlas.sprites,
		failures: result.failures,
	};
}

const CUBE = {
	from: [0, 0, 0],
	to: [16, 16, 16],
	faces: { up: { texture: '#all' }, north: { texture: '#all' } },
};

describe('broken mod assets', () => {
	it('draws an unresolved face with the missing-texture sprite instead of dropping it', async () => {
		// Blockbench leaves `"texture": "#missing"` on unassigned faces, and the
		// game draws those in black and magenta rather than skipping them.
		const pack = await exportFrom('missing-texture', (resources) => {
			resources.set('blockstate', 'example:widget', JSON.stringify({ variants: { '': { model: 'example:block/widget' } } }));
			resources.set('model', 'example:block/widget', JSON.stringify({
				textures: { all: 'example:block/plain' },
				elements: [{ ...CUBE, faces: { up: { texture: '#all' }, north: { texture: '#missing' } } }],
			}));
		});
		const faces = pack.models['example:block/widget'].elements[0].faces;
		expect(Object.keys(faces).toSorted((left, right) => left.localeCompare(right))).toEqual(['north', 'up']);
		expect(faces.north.sprite).toBe('minecraft:missingno');
		expect(pack.sprites['minecraft:missingno']).toBeDefined();
		expect(pack.failures.some(failure => failure.kind === 'texture' && failure.reason.includes('missing-texture'))).toBe(true);
	});

	it('substitutes the missing sprite when a named texture is absent from the jar', async () => {
		// Spectrum names block/stripped_gala_log, which the jar does not ship.
		const pack = await exportFrom('absent-texture', (resources) => {
			resources.set('blockstate', 'example:widget', JSON.stringify({ variants: { '': { model: 'example:block/widget' } } }));
			resources.set('model', 'example:block/widget', JSON.stringify({
				textures: { all: 'example:block/never_shipped' },
				elements: [CUBE],
			}));
		});
		expect(pack.models['example:block/widget'].elements[0].faces.up.sprite).toBe('minecraft:missingno');
		expect(pack.failures.some(failure => failure.kind === 'sprite')).toBe(true);
	});

	it('never names a model it could not export', async () => {
		// AE2 builds its `*_formed` models in Java, so no file exists to read.
		const pack = await exportFrom('absent-model', (resources) => {
			resources.set('blockstate', 'example:widget', JSON.stringify({
				variants: {
					'formed=false': { model: 'example:block/widget' },
					'formed=true': { model: 'example:block/widget_formed' },
				},
			}));
			resources.set('model', 'example:block/widget', JSON.stringify({ textures: { all: 'example:block/plain' }, elements: [CUBE] }));
		});
		const cases = pack.blockStates['example:widget'].variants ?? [];
		expect(cases).toHaveLength(1);
		expect(cases[0].when).toEqual({ formed: 'false' });
		for (const entry of cases.flatMap(one => one.apply)) {
			expect(pack.models).toHaveProperty([entry.model]);
		}
		expect(pack.failures.some(failure => failure.kind === 'model')).toBe(true);
	});

	it('keeps the other states when one variant states no model', async () => {
		const pack = await exportFrom('empty-variant', (resources) => {
			resources.set('blockstate', 'example:widget', JSON.stringify({
				variants: { 'formed=false': { model: 'example:block/widget' }, 'formed=true': {} },
			}));
			resources.set('model', 'example:block/widget', JSON.stringify({ textures: { all: 'example:block/plain' }, elements: [CUBE] }));
		});
		expect(pack.blockStates['example:widget'].variants).toHaveLength(1);
		expect(pack.failures.some(failure => failure.kind === 'blockstate' && failure.reason.includes('case dropped'))).toBe(true);
	});
});

describe('loader extensions', () => {
	it('states the render layer the model declares, over what alpha infers', async () => {
		// Create's composites label their parts `minecraft:translucent` even where
		// the sprite's alpha is only ever 0 or 255.
		const pack = await exportFrom('render-type', (resources) => {
			resources.set('blockstate', 'example:pane', JSON.stringify({ variants: { '': { model: 'example:block/pane' } } }));
			resources.set('model', 'example:block/pane', JSON.stringify({
				render_type: 'minecraft:translucent',
				textures: { all: 'example:block/holed' },
				elements: [CUBE],
			}));
		});
		expect(pack.sprites['example:block/holed'].layer).toBe('cutout');
		expect(pack.models['example:block/pane'].renderType).toBe('translucent');
	});

	it('folds extra_rotation into the element angle', async () => {
		// Supplementaries slants its awnings past vanilla's 22.5 degree steps.
		const pack = await exportFrom('extra-rotation', (resources) => {
			resources.set('blockstate', 'example:awning', JSON.stringify({ variants: { '': { model: 'example:block/awning' } } }));
			resources.set('model', 'example:block/awning', JSON.stringify({
				textures: { all: 'example:block/plain' },
				elements: [{
					...CUBE,
					rotation: { origin: [0, 8, 16], axis: 'x', angle: 0 },
					extra_rotation: 20.5,
				}],
			}));
		});
		expect(pack.models['example:block/awning'].elements[0].rotation?.angle).toBeCloseTo(20.5);
	});

	it('carries a third rotation axis through to the variant', async () => {
		const pack = await exportFrom('z-rotation', (resources) => {
			resources.set('blockstate', 'example:charger', JSON.stringify({
				variants: { 'spin=1': { 'model': 'example:block/charger', 'x': 90, 'example:z': 270 } },
			}));
			resources.set('model', 'example:block/charger', JSON.stringify({ textures: { all: 'example:block/plain' }, elements: [CUBE] }));
		});
		expect(pack.blockStates['example:charger'].variants?.[0].apply[0].z).toBe(270);
	});
});

describe('OBJ geometry', () => {
	/** One textured triangle, in the 0–1 block space OBJ authors use. */
	const OBJ = [
		'mtllib thing.mtl',
		'v 0 0 0',
		'v 1 0 0',
		'v 1 1 0',
		'vt 0 0',
		'vt 1 0',
		'vt 1 1',
		'usemtl skin',
		'f 1/1 2/2 3/3',
	].join('\n');

	it('emits triangles in the same 0–16 space as elements', async () => {
		const pack = await exportFrom('obj', (resources) => {
			resources.set('blockstate', 'example:wheel', JSON.stringify({ variants: { '': { model: 'example:block/wheel' } } }));
			resources.set('model', 'example:block/wheel', JSON.stringify({
				loader: 'forge:obj',
				model: 'example:models/block/thing.obj',
				textures: { skin: 'example:block/plain', particle: 'example:block/plain' },
			}));
			resources.set('raw', 'example:models/block/thing.obj', OBJ);
			resources.set('raw', 'example:models/block/thing.mtl', 'newmtl skin\nmap_Kd #skin\n');
		});
		const mesh = pack.models['example:block/wheel'].mesh;
		expect(mesh).toHaveLength(1);
		expect(mesh?.[0].sprite).toBe('example:block/plain');
		// One triangle: three vertices of three coordinates, scaled 0–1 → 0–16.
		expect(mesh?.[0].positions).toEqual([0, 0, 0, 16, 0, 0, 16, 16, 0]);
		expect(mesh?.[0].uv).toEqual([0, 0, 16, 0, 16, 16]);
		// A mesh is geometry, so the model must not be reported as empty.
		expect(pack.failures.some(failure => failure.kind === 'geometry')).toBe(false);
	});

	it('tags triangles with their OBJ object and flags a multi-state file', async () => {
		// IE packs every state of a block into one OBJ — a workbench's blueprint,
		// a post's arms — and picks between them in a Java callback. Drawing all
		// of them at once is visibly wrong, so where the subset is unknown the
		// pack says which objects are in play and tags each group with its own.
		const twoObjects = [
			'mtllib thing.mtl',
			'v 0 0 0',
			'v 1 0 0',
			'v 1 1 0',
			'v 0 0 1',
			'v 1 0 1',
			'v 1 1 1',
			'vt 0 0',
			'vt 1 0',
			'vt 1 1',
			'usemtl skin',
			'o base',
			'f 1/1 2/2 3/3',
			'o blueprint',
			'f 4/1 5/2 6/3',
		].join('\n');
		const build = (loader: string, extra: Record<string, unknown>) => (resources: MapResourceManager) => {
			resources.set('blockstate', 'example:bench', JSON.stringify({ variants: { '': { model: 'example:block/bench' } } }));
			resources.set('model', 'example:block/bench', JSON.stringify({
				loader,
				...extra,
				model: 'example:models/block/bench.obj',
				textures: { skin: 'example:block/plain', particle: 'example:block/plain' },
			}));
			resources.set('raw', 'example:models/block/bench.obj', twoObjects);
			resources.set('raw', 'example:models/block/bench.mtl', 'newmtl skin\nmap_Kd #skin\n');
		};

		// Plain OBJ: named objects are just how the artist grouped the mesh —
		// Create's track models have 37 — so they are tagged but not flagged.
		const plain = await exportFrom('obj-objects', build('forge:obj', {}));
		expect((plain.models['example:block/bench'].mesh ?? []).map(group => group.object)).toEqual(['base', 'blueprint']);
		expect(plain.failures.some(failure => failure.reason.includes('picks between'))).toBe(false);

		// A loader that states a runtime callback really is choosing between
		// them, and nothing in the assets says which, so the pack says so.
		const conditional = await exportFrom('obj-conditional', build('immersiveengineering:ie_obj', { callbacks: 'example:unknown' }));
		expect((conditional.models['example:block/bench'].mesh ?? []).map(group => group.object)).toEqual(['base', 'blueprint']);
		expect(conditional.failures.some(failure => failure.reason.includes('picks between'))).toBe(true);
	});

	it('restricts a callback whose default is known, without flagging it', async () => {
		// IE's workbench draws its blueprint only when one is inserted.
		const obj = [
			'mtllib thing.mtl',
			'v 0 0 0',
			'v 1 0 0',
			'v 1 1 0',
			'v 0 0 1',
			'v 1 0 1',
			'v 1 1 1',
			'vt 0 0',
			'vt 1 0',
			'vt 1 1',
			'usemtl skin',
			'o cube0',
			'f 1/1 2/2 3/3',
			'o blueprint',
			'f 4/1 5/2 6/3',
		].join('\n');
		const pack = await exportFrom('obj-restricted', (resources) => {
			resources.set('blockstate', 'example:bench', JSON.stringify({ variants: { '': { model: 'example:block/bench' } } }));
			resources.set('model', 'example:block/bench', JSON.stringify({
				loader: 'immersiveengineering:ie_obj',
				callbacks: 'immersiveengineering:workbench',
				model: 'example:models/block/bench.obj',
				textures: { skin: 'example:block/plain', particle: 'example:block/plain' },
			}));
			resources.set('raw', 'example:models/block/bench.obj', obj);
			resources.set('raw', 'example:models/block/bench.mtl', 'newmtl skin\nmap_Kd #skin\n');
		});
		expect((pack.models['example:block/bench'].mesh ?? []).map(group => group.object)).toEqual(['cube0']);
		expect(pack.failures.some(failure => failure.reason.includes('picks between'))).toBe(false);
	});

	it('carries the offsets a split multiblock spans, and says it did', async () => {
		// IE's coke oven is one mesh over 2x2x2 positions; which slice a position
		// draws is in the block entity, so the consumer needs the span to draw it
		// once rather than once per position.
		const pack = await exportFrom('split-multiblock', (resources) => {
			resources.set('blockstate', 'example:oven', JSON.stringify({ variants: { '': { model: 'example:block/oven' } } }));
			resources.set('model', 'example:block/oven', JSON.stringify({
				loader: 'immersiveengineering:basic_split',
				split_parts: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]],
				inner_model: {
					loader: 'forge:obj',
					model: 'example:models/block/oven.obj',
					textures: { skin: 'example:block/plain', particle: 'example:block/plain' },
				},
			}));
			resources.set('raw', 'example:models/block/oven.obj', OBJ);
			resources.set('raw', 'example:models/block/oven.mtl', 'newmtl skin\nmap_Kd #skin\n');
		});
		expect(pack.models['example:block/oven'].multiblock).toHaveLength(4);
		expect(pack.models['example:block/oven'].mesh).toHaveLength(1);
		expect(pack.failures.some(failure => failure.reason.includes('split multiblock'))).toBe(true);
	});

	it('reports an OBJ it cannot read rather than exporting a silent blank', async () => {
		const pack = await exportFrom('obj-missing', (resources) => {
			resources.set('blockstate', 'example:wheel', JSON.stringify({ variants: { '': { model: 'example:block/wheel' } } }));
			resources.set('model', 'example:block/wheel', JSON.stringify({
				loader: 'forge:obj',
				model: 'example:models/block/absent.obj',
				textures: { particle: 'example:block/plain' },
			}));
		});
		expect(pack.models['example:block/wheel'].mesh).toBeUndefined();
		expect(pack.failures.some(failure => failure.kind === 'geometry' && failure.reason.includes('OBJ file not found'))).toBe(true);
	});
});

/**
 * A mod's chest, mob head, sign or fluid is only findable by searching its own
 * assets: `ironchest:crystal_chest` keeps its sheet wherever it likes and no
 * table of vanilla ids would ever name it. These pin the search rather than the
 * table, because the table is the part that cannot scale.
 */
describe('code-drawn blocks in a mod namespace', () => {
	/** A code-drawn block: one empty-key variant on a model with no elements. */
	function codeDrawn(resources: MapResourceManager, id: string): void {
		const name = id.split(':', 2)[1];
		resources.set('blockstate', id, JSON.stringify({ variants: { '': { model: `example:block/${name}` } } }));
		resources.set('model', `example:block/${name}`, JSON.stringify({}));
	}

	it('finds a mod chest sheet nowhere near where vanilla keeps one', async () => {
		// Quark nests its variant chests under `quark_variant_chests/acacia/normal`.
		const pack = await exportFrom('mod-chest', (resources) => {
			codeDrawn(resources, 'example:fancy_chest');
			resources.set('texture', 'example:variant_chests/fancy/normal', solidPng);
		}, true);
		const chest = pack.blockStates['example:fancy_chest'].variants ?? [];
		expect(chest).toHaveLength(4);
		const model = pack.models[chest[0].apply[0].model];
		expect(model.elements.length).toBeGreaterThanOrEqual(3);
		expect(Object.values(model.elements[0].faces)[0].sprite).toBe('example:variant_chests/fancy/normal');
	});

	it('pairs a mod chest whose halves sit beside the base sheet rather than suffixing it', async () => {
		const pack = await exportFrom('mod-chest-double', (resources) => {
			codeDrawn(resources, 'example:fancy_chest');
			for (const leaf of ['normal', 'left', 'right']) {
				resources.set('texture', `example:variant_chests/fancy/${leaf}`, solidPng);
			}
		}, true);
		const chest = pack.blockStates['example:fancy_chest'].variants ?? [];
		expect(chest).toHaveLength(12);
		expect(new Set(chest.map(entry => entry.when.type))).toEqual(new Set(['single', 'left', 'right']));
		const half = pack.models['rendermite:block/fancy_chest_left'];
		expect(Object.values(half.elements[0].faces)[0].sprite).toBe('example:variant_chests/fancy/left');
		// The seam face is never drawn: the partner's is coplanar with it.
		expect(Object.keys(half.elements[0].faces)).not.toContain('west');
	});

	it('leaves a chest with no paired sheets unkeyed so any type still draws', async () => {
		// An ender chest never doubles, and a mod that draws its pair some other
		// way must not end up with a hole where a left half should be.
		const pack = await exportFrom('mod-chest-single', (resources) => {
			codeDrawn(resources, 'example:lonely_chest');
			resources.set('texture', 'example:entity/lonely_chest', solidPng);
		}, true);
		const chest = pack.blockStates['example:lonely_chest'].variants ?? [];
		expect(chest).toHaveLength(4);
		expect(chest.every(entry => entry.when.type === undefined)).toBe(true);
	});

	it('gives a mod fluid a cube on its own still sprite', async () => {
		// Create files fluids under `fluid/`, Immersive Engineering under
		// `block/fluid/`, Mekanism under `liquid/`.
		const pack = await exportFrom('mod-fluid', (resources) => {
			codeDrawn(resources, 'example:biodiesel_fluid_block');
			resources.set('texture', 'example:block/fluid/biodiesel_still', solidPng);
			resources.set('texture', 'example:block/fluid/biodiesel_flow', solidPng);
			resources.set('texture', 'example:block/fluid/diesel_still', holedPng);
		}, true);
		const model = pack.models['rendermite:block/biodiesel_fluid_block'];
		// Every distinguishing token has to land, or this takes the `diesel`
		// sprite sitting beside it.
		expect(model.elements[0].faces.up.sprite).toBe('example:block/fluid/biodiesel_still');
		// The flow sheet is the sibling, which is the part a consumer cannot
		// guess: vanilla is `block/<name>_flow`, Create files fluids under
		// `fluid/`, Mekanism under `liquid/`.
		expect(model.elements[0].faces.north.sprite).toBe('example:block/fluid/biodiesel_flow');
		expect(model.fluid).toEqual({
			still: 'example:block/fluid/biodiesel_still',
			flow: 'example:block/fluid/biodiesel_flow',
		});
	});

	it('does not take a fluid sprite that drops one of the block name tokens', async () => {
		const pack = await exportFrom('mod-fluid-near-miss', (resources) => {
			codeDrawn(resources, 'example:phenolic_resin_fluid_block');
			resources.set('texture', 'example:block/fluid/resin_still', solidPng);
		}, true);
		expect(pack.models['rendermite:block/phenolic_resin_fluid_block']).toBeUndefined();
		expect(pack.failures.some(failure => failure.id === 'example:phenolic_resin_fluid_block')).toBe(true);
	});

	it('finds a mod sign sheet the naming convention does not predict', async () => {
		const pack = await exportFrom('mod-sign', (resources) => {
			codeDrawn(resources, 'example:apricorn_sign');
			resources.set('texture', 'example:entity/sign/apricorn', solidPng);
		}, true);
		expect(pack.blockStates['example:apricorn_sign'].variants).toHaveLength(16);
		const model = pack.models['rendermite:block/apricorn_sign'];
		expect(Object.values(model.elements[0].faces)[0].sprite).toBe('example:entity/sign/apricorn');
	});
});

describe('a block whose shape only its item model has', () => {
	/** A code-drawn block: one empty-key variant on a model with no geometry. */
	function codeDrawn(resources: MapResourceManager, id: string): void {
		const name = id.split(':', 2)[1];
		resources.set('blockstate', id, JSON.stringify({ variants: { '': { model: `example:block/${name}` } } }));
		resources.set('model', `example:block/${name}`, JSON.stringify({ loader: 'example:built_in_java' }));
	}

	it('draws the item model when the block model has no geometry', async () => {
		// Ender IO's conduit, ExtendedAE's matrix glass, PneumaticCraft's tubes:
		// the block model is a loader and nothing else, and the item model the mod
		// needs for the inventory is the only shape the assets hold.
		const pack = await exportFrom('item-model-fallback', (resources) => {
			codeDrawn(resources, 'example:conduit');
			resources.set('model', 'example:item/conduit', JSON.stringify({
				textures: { all: 'example:block/plain' },
				elements: [CUBE],
			}));
		});
		const cases = pack.blockStates['example:conduit'].variants ?? [];
		expect(cases).toHaveLength(1);
		expect(cases[0].apply[0].model).toBe('example:item/conduit');
		expect(pack.models['example:item/conduit'].elements[0].faces.up.sprite).toBe('example:block/plain');
		expect(pack.failures.some(failure => failure.id === 'example:conduit'
			&& failure.reason.includes('example:item/conduit'))).toBe(true);
	});

	it('leaves every state its own rotation when it substitutes', async () => {
		// AE2 builds one drive model for every facing and spin, so the substitute
		// has to land inside the cases rather than replace them.
		const pack = await exportFrom('item-model-oriented', (resources) => {
			resources.set('blockstate', 'example:drive', JSON.stringify({
				variants: {
					'facing=north': { model: 'example:block/drive' },
					'facing=east': { model: 'example:block/drive', y: 90 },
				},
			}));
			resources.set('model', 'example:block/drive', JSON.stringify({ loader: 'example:built_in_java' }));
			resources.set('model', 'example:item/drive', JSON.stringify({
				textures: { all: 'example:block/plain' },
				elements: [CUBE],
			}));
		});
		const cases = pack.blockStates['example:drive'].variants ?? [];
		expect(cases.map(one => [one.when.facing, one.apply[0].model, one.apply[0].y]))
			.toEqual([['north', 'example:item/drive', undefined], ['east', 'example:item/drive', 90]]);
	});

	it('substitutes only the states the mod builds in Java', async () => {
		// AE2 ships no model for a formed quantum ring; the unformed state keeps
		// the one it does ship.
		const pack = await exportFrom('item-model-per-state', (resources) => {
			resources.set('blockstate', 'example:quantum_ring', JSON.stringify({
				variants: {
					'formed=false': { model: 'example:block/ring' },
					'formed=true': { model: 'example:block/ring_formed' },
				},
			}));
			resources.set('model', 'example:block/ring', JSON.stringify({ textures: { all: 'example:block/plain' }, elements: [CUBE] }));
			resources.set('model', 'example:block/ring_formed', JSON.stringify({}));
			resources.set('model', 'example:item/quantum_ring', JSON.stringify({ parent: 'example:block/ring' }));
		});
		const cases = pack.blockStates['example:quantum_ring'].variants ?? [];
		expect(cases.map(one => [one.when.formed, one.apply[0].model]))
			.toEqual([['false', 'example:block/ring'], ['true', 'example:item/quantum_ring']]);
	});

	it('drops the part whether or not the block has an item model to fall back on', async () => {
		// betterend's composters and bookshelves are the shape without one: nothing to stand in, and
		// keeping the part left a case pointing at a model with no elements.
		const pack = await exportFrom('multipart-no-item-model', (resources) => {
			resources.set('blockstate', 'example:shelf', JSON.stringify({
				multipart: [
					{ apply: { model: 'example:block/shelf_contents' } },
					{ when: { slot_0_occupied: true }, apply: { model: 'example:block/shelf_slot' } },
				],
			}));
			resources.set('model', 'example:block/shelf_contents', JSON.stringify({}));
			resources.set('model', 'example:block/shelf_slot', JSON.stringify({ textures: { all: 'example:block/plain' }, elements: [CUBE] }));
		});
		const parts = pack.blockStates['example:shelf'].multipart ?? [];
		expect(parts.map(part => part.apply[0].model)).toEqual(['example:block/shelf_slot']);
	});

	it('leaves a block whose item is a flat icon empty and recorded', async () => {
		// `item/generated` states no elements, so a 2D icon never becomes a plane
		// standing in a chunk.
		const pack = await exportFrom('item-model-flat', (resources) => {
			codeDrawn(resources, 'example:widget');
			resources.set('model', 'example:item/widget', JSON.stringify({
				parent: 'minecraft:item/generated',
				textures: { layer0: 'example:block/plain' },
			}));
		});
		expect(pack.models['example:item/widget']).toBeUndefined();
		expect(pack.failures.some(failure => failure.id === 'example:widget'
			&& failure.reason.includes('no geometry is vendored'))).toBe(true);
	});

	it('gives an empty model a particle from any texture it binds', async () => {
		// A consumer with no geometry has only the particle to colour a
		// placeholder with, and the models that draw nothing are the ones least
		// likely to name one.
		const pack = await exportFrom('empty-model-particle', (resources) => {
			codeDrawn(resources, 'example:widget');
			resources.set('model', 'example:block/widget', JSON.stringify({ textures: { all: 'example:block/plain' } }));
		});
		expect(pack.models['example:block/widget'].particle).toBe('example:block/plain');
	});

	it('draws a block whose blockstate names a model type rather than a model', async () => {
		// NeoForge lets a mod register a model *type* and name it in a variant:
		// Ender IO writes `{"": {"type": "enderio:conduit"}}`, which leaves no
		// usable case and used to leave the block out of the pack entirely.
		const pack = await exportFrom('variant-model-type', (resources) => {
			resources.set('blockstate', 'example:conduit', JSON.stringify({
				variants: { '': { type: 'example:conduit' } },
			}));
			resources.set('model', 'example:item/conduit', JSON.stringify({
				textures: { all: 'example:block/plain' },
				elements: [CUBE],
			}));
		});
		const cases = pack.blockStates['example:conduit'].variants ?? [];
		expect(cases).toEqual([{ when: {}, apply: [{ model: 'example:item/conduit' }] }]);
		expect(pack.models['example:item/conduit'].elements).toHaveLength(1);
		expect(pack.failures.some(failure => failure.id === 'example:conduit'
			&& failure.reason.includes('no case of this blockstate could be read'))).toBe(true);
	});

	it('drops a code-drawn multipart part rather than laying an item model over the parts that draw', async () => {
		/*
		 * `morered:wire_parts` holds the `line` and `edge` shapes a wire draws *between* blocks and
		 * picks per neighbour in Java, and which neighbours those are is nowhere in the saved state.
		 * Taking whichever shape the file named first put a stub in a corner of every wire; standing
		 * the item model in for it instead put a flat cross on every wire whichever wall it was on,
		 * because a multipart part draws *as well as* every other match rather than instead of one.
		 * Neither is the wire. What the pack can place correctly is the oriented node the mod's own
		 * blockstate ships, so the unreadable part is dropped and recorded.
		 */
		const pack = await exportFrom('morered-wire', (resources) => {
			resources.set('blockstate', 'example:red_alloy_wire', JSON.stringify({
				multipart: [
					{ apply: { model: 'example:block/red_alloy_wire_parts' } },
					{ when: { down: 'true' }, apply: { model: 'example:block/red_alloy_wire_node' } },
				],
			}));
			resources.set('model', 'example:block/red_alloy_wire_parts', JSON.stringify({
				loader: 'morered:wire_parts',
				line: { parent: 'example:block/red_alloy_wire_line' },
				edge: { parent: 'example:block/red_alloy_wire_edge' },
			}));
			const stub = (from: number[], to: number[]): string => JSON.stringify({
				textures: { wire: 'example:block/plain' },
				elements: [{ from, to, faces: { up: { texture: '#wire' } } }],
			});
			resources.set('model', 'example:block/red_alloy_wire_line', stub([7, 0, 0], [9, 2, 7]));
			resources.set('model', 'example:block/red_alloy_wire_edge', stub([0, 0, 7], [2, 2, 9]));
			resources.set('model', 'example:block/red_alloy_wire_node', stub([7, 0, 7], [9, 2, 9]));
			resources.set('model', 'example:item/red_alloy_wire', JSON.stringify({
				textures: { wire: 'example:block/plain' },
				elements: [
					{ from: [7, 0, 0], to: [9, 2, 16], faces: { up: { texture: '#wire' } } },
					{ from: [0, 0, 7], to: [16, 2, 9], faces: { up: { texture: '#wire' } } },
				],
			}));
		});
		const parts = pack.blockStates['example:red_alloy_wire'].multipart ?? [];
		// Only the part that draws, and it keeps the `when` that puts it on the right face
		expect(parts.map(part => [part.when, part.apply[0].model]))
			.toEqual([[{ op: 'match', properties: { down: ['true'] } }, 'example:block/red_alloy_wire_node']]);
		expect(pack.failures.some(failure => failure.id === 'example:red_alloy_wire'
			&& failure.reason.includes('drops those parts'))).toBe(true);
	});
});
