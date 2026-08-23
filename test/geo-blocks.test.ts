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

	it('does not guess that an unrelated block uses a same-named geo', async () => {
		expect(await geoBlockModel('example:imbuement_chamber', new MapResourceManager())).toBeNull();
	});
});
