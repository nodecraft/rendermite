import { describe, expect, it } from 'vitest';

import { enderStorageBlockModel } from '../src/blocks/ender-storage.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

describe('Ender Storage block models', () => {
	it('applies CodeChickenLib swapYZ and emits a two-sided tank OBJ mesh', async () => {
		const resources = new MapResourceManager().set('raw', 'enderstorage:models/endertank.obj', [
			'g Glass',
			'v 0 0 0',
			'v 1 0 0',
			'v 0 1 0',
			'vt 0 0',
			'vt 1 0',
			'vt 0 1',
			'f 1/1 2/2 3/3',
		].join('\n'));

		const model = await enderStorageBlockModel('enderstorage:ender_tank', resources);
		expect(model).toMatchObject({ particle: 'enderstorage:endertank', renderType: 'cutout' });
		expect(model?.mesh).toHaveLength(1);
		expect(model?.mesh?.[0]).toMatchObject({ object: 'Glass', sprite: 'enderstorage:endertank' });
		// The original triangle plus CCL's reversed backfaced copy.
		expect(model?.mesh?.[0].positions).toHaveLength(18);
		expect(model?.mesh?.[0].positions).toContain(15.842);
		// Original OBJ y becomes block z; all original z values become block y.
		expect(model?.mesh?.[0].positions.filter((_value, index) => index % 3 === 1)).toStrictEqual([0, 0, 0, 0, 0, 0]);
	});

	it('does not claim unrelated Java-rendered blocks', async () => {
		expect(await enderStorageBlockModel('minecraft:chest', new MapResourceManager())).toBeNull();
	});
});
