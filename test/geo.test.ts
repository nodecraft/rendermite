/**
 * GeckoLib geometry discovery. The geo file and its skin are linked only by
 * name — the mod binds them in Java — so every rule here is about deciding
 * which file belongs to an item without ever pairing it with another item's.
 */

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { ModelLoader } from '../src/models/loader.ts';
import { toFloatTexture } from '../src/render/blend.ts';
import { createShadeCache, renderFace } from '../src/render/face.ts';
import {
	findGeoForItem,
	geoToFaces,
	parseGeo,
	renderGeo,
} from '../src/render/geo.ts';
import { lightsForProfile } from '../src/render/lighting.ts';
import { renderModel } from '../src/render/renderer.ts';
import { displayMatrix } from '../src/render/vector.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { TextureLoader } from '../src/textures/loader.ts';

import type { FloatTexture } from '../src/render/blend.ts';
import type { FaceGeometry } from '../src/render/geometry.ts';

/** A one-cube geo, which is all findGeoForItem needs to parse successfully. */
function geoFile(): Buffer {
	return Buffer.from(JSON.stringify({
		'minecraft:geometry': [{
			description: { texture_width: 16, texture_height: 16 },
			bones: [{ name: 'root', pivot: [0, 0, 0], cubes: [{ origin: [0, 0, 0], size: [8, 8, 8], uv: [0, 0] }] }],
		}],
	}));
}

async function skin(): Promise<Buffer> {
	return sharp({ create: { width: 16, height: 16, channels: 4, background: { r: 200, g: 100, b: 50, alpha: 1 } } })
		.png()
		.toBuffer();
}

describe('geo skin naming', () => {
	it('accepts a skin decorated with a _texture suffix', async () => {
		// pokeblocks files all 344 figurines as <name>_texture.png.
		const resources = new MapResourceManager()
			.set('raw', 'mod:geo/statue.geo.json', geoFile())
			.set('texture', 'mod:block/statue_texture', await skin());
		const found = await findGeoForItem(resources, 'mod:statue');
		expect(found?.texture.toString()).toBe('mod:block/statue_texture');
	});

	it('prefers an exactly named skin over a decorated one', async () => {
		const resources = new MapResourceManager()
			.set('raw', 'mod:geo/statue.geo.json', geoFile())
			.set('texture', 'mod:block/statue_texture', await skin())
			.set('texture', 'mod:block/statue', await skin());
		const found = await findGeoForItem(resources, 'mod:statue');
		expect(found?.texture.toString()).toBe('mod:block/statue');
	});
});

describe('geo variants sharing a base shape', () => {
	it('falls back to a geo whose tokens the item name contains', async () => {
		// pokeblocks draws gigantic_pokedoll_absol from pokedoll_absol.geo.json.
		const resources = new MapResourceManager()
			.set('raw', 'mod:geo/pokedoll_absol.geo.json', geoFile())
			.set('texture', 'mod:block/pokedoll_absol_texture', await skin());
		const found = await findGeoForItem(resources, 'mod:gigantic_pokedoll_absol');
		expect(found).not.toBeNull();
	});

	it('gives a variant its own skin rather than the base shape\'s', async () => {
		// pokedoll_shiny_absol shares pokedoll_absol's geometry but not its
		// colours, and wearing the base skin would be the wrong doll entirely.
		const resources = new MapResourceManager()
			.set('raw', 'mod:geo/pokedoll_absol.geo.json', geoFile())
			.set('texture', 'mod:block/pokedoll_absol_texture', await skin())
			.set('texture', 'mod:block/pokedoll_absol_shiny_texture', await skin());
		const found = await findGeoForItem(resources, 'mod:pokedoll_shiny_absol');
		expect(found?.texture.toString()).toBe('mod:block/pokedoll_absol_shiny_texture');
	});

	it('picks the most specific base when several are subsets', async () => {
		const resources = new MapResourceManager()
			.set('raw', 'mod:geo/pokedoll.geo.json', geoFile())
			.set('raw', 'mod:geo/pokedoll_absol.geo.json', geoFile())
			.set('texture', 'mod:block/pokedoll_texture', await skin())
			.set('texture', 'mod:block/pokedoll_absol_texture', await skin());
		const found = await findGeoForItem(resources, 'mod:gigantic_pokedoll_absol');
		expect(found?.texture.toString()).toBe('mod:block/pokedoll_absol_texture');
	});

	it('never borrows a geo the item name does not contain', async () => {
		// The rule is a subset test, not a similarity score: a sibling variant
		// must not stand in for an item the mod models separately.
		const resources = new MapResourceManager()
			.set('raw', 'mod:geo/pokedoll_pikachu.geo.json', geoFile())
			.set('texture', 'mod:block/pokedoll_pikachu_texture', await skin());
		expect(await findGeoForItem(resources, 'mod:pokedoll_absol')).toBeNull();
	});
});

describe('geo face winding', () => {
	/** One solid colour per face, so a render names the faces it actually shows. */
	const FACE_COLORS: Record<string, [number, number, number]> = {
		down: [255, 0, 0],
		up: [0, 255, 0],
		north: [0, 0, 255],
		south: [255, 255, 0],
		west: [255, 0, 255],
		east: [0, 255, 255],
	};
	const ORDER = ['down', 'up', 'north', 'south', 'west', 'east'];

	async function strip(): Promise<Buffer> {
		const raw = Buffer.alloc(ORDER.length * 4);
		for (const [index, direction] of ORDER.entries()) {
			raw.set([...FACE_COLORS[direction], 255], index * 4);
		}
		return sharp(raw, { raw: { width: ORDER.length, height: 1, channels: 4 } }).png().toBuffer();
	}

	/** Which face colours survived to the render, most pixels first. */
	function facesShown(texture: FloatTexture | null): string[] {
		const seen = new Map<string, number>();
		for (let offset = 0; offset < (texture?.data.length ?? 0); offset += 4) {
			const data = texture!.data;
			if (data[offset + 3] < 0.5) {
				continue;
			}
			let best = '';
			let bestDistance = Infinity;
			for (const direction of ORDER) {
				const [red, green, blue] = FACE_COLORS[direction];
				const distance = Math.abs(data[offset] * 255 - red) + Math.abs(data[offset + 1] * 255 - green) + Math.abs(data[offset + 2] * 255 - blue);
				if (distance >= bestDistance) {
					continue;
				}
				bestDistance = distance;
				best = direction;
			}
			seen.set(best, (seen.get(best) ?? 0) + 1);
		}
		// Anti-aliased edges contribute a few stray pixels; only real faces count.
		return [...seen].filter(([, count]) => count > 200).map(([direction]) => direction);
	}

	it('shows the same kind of faces as the element renderer, not the far side', async () => {
		// Mirroring X reverses each quad's winding, so without a compensating
		// reversal the cull keeps the back faces and a cube renders its underside.
		const faces: Record<string, unknown> = {};
		for (const direction of ORDER) {
			const index = ORDER.indexOf(direction);
			faces[direction] = { texture: '#t', uv: [index * 16 / ORDER.length, 0, (index + 1) * 16 / ORDER.length, 16] };
		}
		const resources = new MapResourceManager()
			.set('texture', 'test:block/strip', await strip())
			.set('model', 'test:item/cube', JSON.stringify({
				textures: { t: 'test:block/strip' },
				display: { gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
				elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces }],
			}));
		const textures = new TextureLoader(resources);
		const options = { size: 64, quality: 1, lightingProfile: 'modern' as const };

		const model = await new ModelLoader(resources).load('test:item/cube');
		const viaElements = facesShown(await renderModel(model, textures, options));
		const geo = parseGeo({
			'minecraft:geometry': [{
				description: { texture_width: ORDER.length, texture_height: 1 },
				bones: [{
					name: 'b',
					pivot: [0, 0, 0],
					cubes: [{
						origin: [0, 0, 0],
						size: [16, 16, 16],
						uv: Object.fromEntries(ORDER.map(direction => [direction, { uv: [ORDER.indexOf(direction), 0], uv_size: [1, 1] }])),
					}],
				}],
			}],
		});
		const viaGeo = facesShown(await renderGeo(geo!, ResourceLocator.parse('test:block/strip'), textures, options));

		// The X mirror swaps east and west, so the pair is not expected to match
		// exactly — but both must draw the top and neither may draw the underside.
		expect(viaElements).toContain('up');
		expect(viaGeo).toContain('up');
		expect(viaGeo).not.toContain('down');
		expect(viaGeo).toHaveLength(viaElements.length);
	});
});

describe('compact cube UVs', () => {
	it('uses Bedrock\'s down/up and west/north/east/south unwrap order', () => {
		const geo = parseGeo({
			'minecraft:geometry': [{
				description: { texture_width: 64, texture_height: 64 },
				bones: [{
					name: 'asymmetric',
					cubes: [{ origin: [0, 0, 0], size: [4, 8, 2], uv: [10, 20] }],
				}],
			}],
		});
		const rects = Object.fromEntries(geoToFaces(geo!, { fit: false }).map(face => [
			face.direction,
			[
				face.uv1[0] * 64,
				face.uv1[1] * 64,
				face.uv2[0] * 64,
				face.uv2[1] * 64,
			],
		]));

		expect(rects).toStrictEqual({
			up: [12, 20, 16, 22],
			down: [16, 22, 20, 20],
			north: [12, 22, 16, 30],
			south: [18, 22, 22, 30],
			east: [10, 22, 12, 30],
			west: [16, 22, 18, 30],
		});
	});

	it('keeps named east and west UVs on their physical sides after the X mirror', () => {
		const geo = parseGeo({
			'minecraft:geometry': [{
				description: { texture_width: 64, texture_height: 64 },
				bones: [{
					name: 'asymmetric',
					cubes: [{
						origin: [2, 0, 0],
						size: [4, 8, 2],
						uv: {
							east: { uv: [1, 2], uv_size: [2, 8] },
							west: { uv: [21, 22], uv_size: [2, 8] },
						},
					}],
				}],
			}],
		});
		const faces = Object.fromEntries(geoToFaces(geo!, { fit: false }).map(face => [face.direction, face]));

		// Source x=2 mirrors to physical x=-2 (east); source x=6 mirrors to x=-6 (west).
		expect(faces.east.vertices.every(vertex => vertex[0] === -2)).toBe(true);
		expect(faces.west.vertices.every(vertex => vertex[0] === -6)).toBe(true);
		expect(faces.east.uvs).toStrictEqual([[3 / 64, 2 / 64], [3 / 64, 10 / 64], [1 / 64, 10 / 64], [1 / 64, 2 / 64]]);
		expect(faces.west.uvs).toStrictEqual([[23 / 64, 22 / 64], [23 / 64, 30 / 64], [21 / 64, 30 / 64], [21 / 64, 22 / 64]]);
	});
});

describe('shading paths agree', () => {
	it('renders a face identically whether shaded via cache or per sample', async () => {
		// A face is drawn against a pre-shaded copy while the cache budget holds
		// and shaded texel-by-texel once it is spent. The two are only
		// interchangeable if they produce the same pixels, so compare them directly.
		const raw = Buffer.alloc(4 * 4 * 4);
		for (let index = 0; index < 16; index++) {
			// Varied colour and alpha so every branch of shadeTexel is exercised.
			raw.set([index * 15, 255 - index * 15, index * 7, index % 3 === 0 ? 255 : index * 16], index * 4);
		}
		const texture = toFloatTexture({
			width: 4,
			height: 4,
			data: new Uint8ClampedArray(raw),
		});
		const geometry: FaceGeometry = {
			direction: 'up',
			vertices: [[0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]],
			uv1: [0, 0],
			uv2: [1, 1],
			textureRef: '#t',
			rotation: 0,
			tintIndex: 0,
			shadeDirectionOverride: null,
			emissive: false,
			alpha: 0.75,
		};
		const face = {
			geometry,
			texture,
			light: lightsForProfile('modern').side,
			tint: { r: 0.6, g: 0.9, b: 0.3 },
			maxZ: 1,
		};
		const transformation = displayMatrix([30, 225, 0], [0, 0, 0], [0.625, 0.625, 0.625]);

		const viaCache = renderFace(face, 32, 32, transformation, undefined, createShadeCache());
		const viaSamples = renderFace(face, 32, 32, transformation);
		expect(viaCache).not.toBeNull();
		expect(viaSamples).not.toBeNull();
		expect(viaSamples!.colors.length).toBe(viaCache!.colors.length);
		let differing = 0;
		for (let index = 0; index < viaCache!.colors.length; index++) {
			if (viaCache!.colors[index] !== viaSamples!.colors[index]) {
				differing++;
			}
		}
		expect(differing).toBe(0);
	});
});
