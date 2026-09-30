import { describe, expect, it } from 'vitest';

import { combineFaceBuffers } from '../src/render/compose.ts';
import { buildElementFaces } from '../src/render/geometry.ts';
import { guiSideLight, legacyFrontLight, legacySideLight } from '../src/render/lighting.ts';
import { compactFaceBuffer, createFaceBuffer, phpRound } from '../src/render/rasterizer.ts';
import { boxDownscale } from '../src/render/renderer.ts';
import { parseTintValue, resolveTint } from '../src/render/tints.ts';
import {
	displayMatrix,
	identity,
	multiply,
	transformVector,
} from '../src/render/vector.ts';

describe('phpRound', () => {
	it('rounds half away from zero like PHP', () => {
		expect(phpRound(0.5)).toBe(1);
		expect(phpRound(-0.5)).toBe(-1);
		expect(phpRound(1.4)).toBe(1);
		expect(phpRound(-1.4)).toBe(-1);
	});
});

describe('compactFaceBuffer', () => {
	it('retains visible colors and depths in their original image position', () => {
		const full = createFaceBuffer(5, 4);
		const first = full.width + 2;
		const second = 2 * full.width + 3;
		full.colors.set([0.1, 0.2, 0.3, 0.4], first * 4);
		full.colors.set([0.5, 0.6, 0.7, 0.8], second * 4);
		full.depths[first] = 0.25;
		full.depths[second] = 0.75;

		const compact = compactFaceBuffer(full);
		expect(compact).not.toBeNull();
		expect(compact && { x: compact.x, y: compact.y, width: compact.width, height: compact.height })
			.toEqual({ x: 2, y: 1, width: 2, height: 2 });
		expect(compact?.colors[3]).toBeCloseTo(0.4);
		expect(compact?.colors[15]).toBeCloseTo(0.8);
		expect(compact?.depths[0]).toBe(0.25);
		expect(compact?.depths[3]).toBe(0.75);
	});

	it('composes identically to the full-size buffers', () => {
		const back = createFaceBuffer(4, 3);
		const front = createFaceBuffer(4, 3);
		for (const [buffer, x, y, depth, color] of [
			[back, 1, 1, 0.25, [1, 0, 0, 0.5]],
			[front, 1, 1, 0.75, [0, 0, 1, 0.5]],
			[front, 2, 1, 0.75, [0, 1, 0, 1]],
		] as const) {
			const pixel = y * buffer.width + x;
			buffer.depths[pixel] = depth;
			buffer.colors.set(color, pixel * 4);
		}
		const expected = combineFaceBuffers(4, 3, [back, front]);
		const compact = [compactFaceBuffer(back), compactFaceBuffer(front)]
			.filter(buffer => buffer !== null);
		const actual = combineFaceBuffers(4, 3, compact);
		expect([...actual.data]).toEqual([...expected.data]);
	});
});

describe('boxDownscale', () => {
	it('averages colour over the samples that have alpha, and alpha over all of them', () => {
		// Opaque red beside transparent blue, above a transparent row: the blue must not tint the red
		const texture = {
			width: 2,
			height: 2,
			data: new Float64Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0]),
		};
		const { width, height, data } = boxDownscale(texture, 2);
		expect({ width, height }).toEqual({ width: 1, height: 1 });
		// Each pass stores a Q16 quantum rounding half up: 65535 / 2 is 32768, then 32768 / 2 is 16384
		expect([...data]).toEqual([1, 0, 0, 16384 / 65535]);
	});

	it('leaves a fully transparent pixel black', () => {
		const texture = { width: 2, height: 2, data: new Float64Array([0.5, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0, 0.5, 0.5, 0.5, 0]) };
		expect([...boxDownscale(texture, 2).data]).toEqual([0, 0, 0, 0]);
	});
});

describe('displayMatrix', () => {
	it('is identity for default display settings', () => {
		const matrix = displayMatrix([0, 0, 0], [0, 0, 0], [1, 1, 1]);
		const vec = transformVector(matrix, [0.25, 0.5, 0.75]);
		expect(vec[0]).toBeCloseTo(0.25, 12);
		expect(vec[1]).toBeCloseTo(0.5, 12);
		expect(vec[2]).toBeCloseTo(0.75, 12);
	});

	it('pivots rotation around the cube center', () => {
		const matrix = displayMatrix([0, 180, 0], [0, 0, 0], [1, 1, 1]);
		const vec = transformVector(matrix, [0, 0.5, 0.5]);
		expect(vec[0]).toBeCloseTo(1, 12);
		expect(vec[1]).toBeCloseTo(0.5, 12);
		expect(vec[2]).toBeCloseTo(0.5, 12);
	});

	it('applies translation in sixteenths', () => {
		const matrix = displayMatrix([0, 0, 0], [8, 0, 0], [1, 1, 1]);
		expect(transformVector(matrix, [0, 0, 0])[0]).toBeCloseTo(0.5, 12);
	});
});

describe('lighting profiles', () => {
	it('legacy front light leaves faces unshaded', () => {
		expect(legacyFrontLight().lightLevelForNormal([0, 0, 1])).toBe(1);
	});

	it('legacy side light darkens down-facing normals more than up-facing', () => {
		const light = legacySideLight();
		const up = light.lightLevelForNormal([0, 1, 0]);
		const down = light.lightLevelForNormal([0, -1, 0]);
		expect(up).toBeGreaterThan(down);
	});

	it('modern side light stays within [0.4, 1]', () => {
		const light = guiSideLight();
		for (const normal of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [0, 0, -1]] as const) {
			const level = light.lightLevelForNormal([normal[0], normal[1], normal[2]]);
			expect(level).toBeGreaterThanOrEqual(0.4);
			expect(level).toBeLessThanOrEqual(1);
		}
	});
});

describe('parseTintValue', () => {
	it('treats null and -1 as untinted', () => {
		expect(parseTintValue(null)).toBeNull();
		expect(parseTintValue(-1)).toBeNull();
	});

	it('unpacks packed integers as RGB', () => {
		const color = parseTintValue(0xFF_80_40);
		expect(color).toEqual({ r: 1, g: 0x80 / 255, b: 0x40 / 255 });
	});

	it('accepts float triples', () => {
		expect(parseTintValue([0.5, 0.25, 1])).toEqual({ r: 0.5, g: 0.25, b: 1 });
	});
});

describe('resolveTint', () => {
	it('uses the default value of custom namespaced tint types', async () => {
		const color = await resolveTint(
			{ type: 'modernmod:effect_buildup', default: 0x00_CC_40 },
			{ textures: null as never },
		);
		expect(color).toEqual({ r: 0, g: 0xCC / 255, b: 0x40 / 255 });
	});
});

describe('buildElementFaces', () => {
	it('builds a full cube with auto UVs', () => {
		const faces = buildElementFaces({
			from: [0, 0, 0],
			to: [16, 16, 16],
			faces: {
				up: { texture: '#top' },
				north: { texture: '#side' },
			},
		});
		expect(faces).toHaveLength(2);
		const north = faces.find(face => face.direction === 'north');
		expect(north?.uv1).toEqual([0, 0]);
		expect(north?.uv2).toEqual([1, 1]);
	});

	it('rotation mutates shared corners after UV capture', () => {
		const faces = buildElementFaces({
			from: [0, 0, 0],
			to: [16, 16, 16],
			rotation: { origin: [8, 8, 8], axis: 'y', angle: 45 },
			faces: { north: { texture: '#side' } },
		});
		const north = faces[0];
		// UVs captured before rotation stay axis-aligned.
		expect(north.uv1).toEqual([0, 0]);
		// Vertices moved: corner e = (1,1,0) rotated 45° about y around (0.5,0.5,0.5).
		const [v0] = north.vertices;
		expect(v0[1]).toBeCloseTo(1, 12);
		expect(v0[0]).not.toBeCloseTo(1, 3);
	});

	it('scales explicit uv by sixteen', () => {
		const faces = buildElementFaces({
			from: [0, 0, 0],
			to: [16, 8, 16],
			faces: { south: { texture: '#side', uv: [0, 8, 16, 16], rotation: 90, tintindex: 0 } },
		});
		expect(faces[0].uv1).toEqual([0, 0.5]);
		expect(faces[0].uv2).toEqual([1, 1]);
		expect(faces[0].rotation).toBe(90);
		expect(faces[0].tintIndex).toBe(0);
	});
});

describe('matrix composition', () => {
	it('multiply matches column-major convention', () => {
		const matrix = multiply(identity(), identity());
		expect([...matrix]).toEqual([...identity()]);
	});
});
