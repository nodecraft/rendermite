/**
 * Resolving a block item's model through its blockstate — the model a
 * block-entity item renderer draws, which no same-name lookup would find.
 */

import { describe, expect, it } from 'vitest';

import { blockStateTransform, defaultBlockStateModel } from '../src/items/blockstate.ts';
import { transformVector } from '../src/render/vector.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

function pack(id: string, json: unknown): MapResourceManager {
	return new MapResourceManager().set('blockstate', id, JSON.stringify(json));
}

describe('default blockstate model', () => {
	it('returns null when the item has no blockstate', async () => {
		const resources = new MapResourceManager();
		expect(await defaultBlockStateModel(resources, 'example:widget')).toBeNull();
	});

	it('takes the sole variant of a single-state block', async () => {
		const resources = pack('example:tank', { variants: { '': { model: 'example:block/tank' } } });
		const resolved = await defaultBlockStateModel(resources, 'example:tank');
		expect(String(resolved?.model)).toBe('example:block/tank');
		expect([resolved?.xRotation, resolved?.yRotation]).toEqual([0, 0]);
	});

	it('prefers the unrotated default facing over the rotated ones', async () => {
		// Picking `facing=east` would turn the icon away from the camera.
		const resources = pack('example:cube', {
			variants: {
				'facing=up': { model: 'example:block/cube', x: -90 },
				'facing=east': { model: 'example:block/cube', y: 90 },
				'facing=north': { model: 'example:block/cube' },
			},
		});
		const resolved = await defaultBlockStateModel(resources, 'example:cube');
		expect([resolved?.xRotation, resolved?.yRotation]).toEqual([0, 0]);
	});

	it('prefers the idle state of a machine', async () => {
		const resources = pack('example:machine', {
			variants: {
				'active=true': { model: 'example:block/machine_active' },
				'active=false': { model: 'example:block/machine' },
			},
		});
		const resolved = await defaultBlockStateModel(resources, 'example:machine');
		expect(String(resolved?.model)).toBe('example:block/machine');
	});

	it('takes the first entry of a weighted variant list', async () => {
		const resources = pack('example:rubble', {
			variants: { '': [{ model: 'example:block/rubble_a' }, { model: 'example:block/rubble_b' }] },
		});
		const resolved = await defaultBlockStateModel(resources, 'example:rubble');
		expect(String(resolved?.model)).toBe('example:block/rubble_a');
	});

	it('falls to the unconditional piece of a multipart blockstate', async () => {
		const resources = pack('example:fence', {
			multipart: [
				{ apply: { model: 'example:block/fence_post' } },
				{ when: { north: 'true' }, apply: { model: 'example:block/fence_side' } },
			],
		});
		const resolved = await defaultBlockStateModel(resources, 'example:fence');
		expect(String(resolved?.model)).toBe('example:block/fence_post');
	});

	it('qualifies a bare model path with the item namespace', async () => {
		const resources = pack('example:thing', { variants: { '': { model: 'block/thing' } } });
		const resolved = await defaultBlockStateModel(resources, 'example:thing');
		expect(String(resolved?.model)).toBe('example:block/thing');
	});

	it('survives a blockstate that states nothing usable', async () => {
		const resources = pack('example:broken', { variants: {} });
		expect(await defaultBlockStateModel(resources, 'example:broken')).toBeNull();
	});
});

describe('blockstate transform', () => {
	it('is the identity when the variant is unrotated', () => {
		const matrix = blockStateTransform({ model: null as never, xRotation: 0, yRotation: 0 });
		expect([...matrix].map(value => Math.round(value * 1000) / 1000))
			.toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
	});

	it('rotates about the block centre, so the model stays in the cube', () => {
		const matrix = blockStateTransform({ model: null as never, xRotation: 0, yRotation: 90 });
		const round = (point: number[]): number[] => point.map(value => Math.round(value * 1000) / 1000);
		// The centre is the fixed point of a blockstate rotation...
		expect(round(transformVector(matrix, [0.5, 0.5, 0.5]))).toEqual([0.5, 0.5, 0.5]);
		// ...and vanilla's BlockModelRotation negates the angle, so a y=90 variant
		// swings +x round to +z. Still inside the cube, never mirrored.
		expect(round(transformVector(matrix, [1, 0.5, 0.5]))).toEqual([0.5, 0.5, 1]);
	});
});
