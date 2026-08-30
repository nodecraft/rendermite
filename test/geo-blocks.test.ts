import { describe, expect, it } from 'vitest';

import { geoBlockModel } from '../src/blocks/geo-blocks.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

describe('Gecko block models', () => {
	it('replaces an Ars placeholder cube with its open runtime geometry', async () => {
		const resources = new MapResourceManager().set('raw', 'ars_nouveau:geo/imbuement_chamber.geo.json', JSON.stringify({
			'format_version': '1.12.0',
			'minecraft:geometry': [{
				description: { texture_width: 32, texture_height: 32 },
				bones: [{
					name: 'frame',
					pivot: [0, 0, 0],
					cubes: [
						{ origin: [-8, 0, -8], size: [2, 16, 2], uv: [0, 0] },
						{ origin: [6, 0, 6], size: [2, 16, 2], uv: [8, 0] },
					],
				}],
			}],
		}));

		const model = await geoBlockModel('ars_nouveau:imbuement_chamber', resources);
		expect(model?.model).toMatchObject({ ao: false, elements: [], renderType: 'cutout' });
		expect(model?.model.mesh).toHaveLength(1);
		expect(model?.model.mesh?.[0].sprite).toBe('ars_nouveau:block/imbuement_chamber');
		// Two cubes, six quads each, two triangles per quad, three vertices per triangle.
		expect(model?.model.mesh?.[0].positions).toHaveLength(2 * 6 * 2 * 3 * 3);
		expect(new Set(model?.model.mesh?.[0].positions)).not.toEqual(new Set([0, 16]));
	});

	it('discovers same-named nested block geometry and keeps its multiblock scale', async () => {
		const resources = new MapResourceManager()
			.set('raw', 'machines:geo/block/models/solar.geo.json', JSON.stringify({
				'format_version': '1.12.0',
				'minecraft:geometry': [{
					description: { texture_width: 64, texture_height: 64 },
					bones: [{ name: 'panel', cubes: [{ origin: [-24, 0, -8], size: [48, 2, 16], uv: [0, 0] }] }],
				}],
			}))
			.set('texture', 'machines:block/models/solar', Buffer.from('texture'));

		const override = await geoBlockModel('machines:solar', resources);
		expect(override?.javaFacing).toBe(true);
		const positions = override?.model.mesh?.[0].positions ?? [];
		const xs = positions.filter((_, index) => index % 3 === 0);
		expect(Math.min(...xs)).toBe(-16);
		expect(Math.max(...xs)).toBe(32);
	});

	it('emits every cube face counter-clockwise when viewed from outside', async () => {
		const resources = new MapResourceManager()
			.set('raw', 'machines:geo/block/models/controller.geo.json', JSON.stringify({
				'format_version': '1.12.0',
				'minecraft:geometry': [{
					description: { texture_width: 16, texture_height: 16 },
					bones: [{ name: 'controller', cubes: [{ origin: [-8, 0, -8], size: [16, 16, 16], uv: [0, 0] }] }],
				}],
			}))
			.set('texture', 'machines:block/models/controller', Buffer.from('texture'));
		const override = await geoBlockModel('machines:controller', resources);
		const positions = override?.model.mesh?.[0].positions ?? [];
		const center = [8, 8, 8];
		expect(positions).toHaveLength(12 * 3 * 3);

		for (let offset = 0; offset < positions.length; offset += 9) {
			const first = positions.slice(offset, offset + 3);
			const second = positions.slice(offset + 3, offset + 6);
			const third = positions.slice(offset + 6, offset + 9);
			const edgeA = second.map((value, axis) => value - first[axis]);
			const edgeB = third.map((value, axis) => value - first[axis]);
			const normal = [
				edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
				edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
				edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
			];
			const centroid = first.map((value, axis) => (value + second[axis] + third[axis]) / 3);
			const outward = normal.reduce((dot, value, axis) => dot + value * (centroid[axis] - center[axis]), 0);
			expect(outward).toBeGreaterThan(0);
		}
	});

	it('does not guess that an unrelated block uses a same-named geo', async () => {
		expect(await geoBlockModel('example:imbuement_chamber', new MapResourceManager())).toBeNull();
	});
});
