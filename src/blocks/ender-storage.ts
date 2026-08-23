/** Geometry for Ender Storage blocks whose shipped JSON model is only an empty Java-renderer hook. */

import { parseObj } from '../render/obj.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { MeshGroup } from './obj-mesh.ts';
import type { BlockPackModel } from './pack-format.ts';
import type { ResourceManager } from '../resources/manager.ts';

const BLOCK_UNITS = 16;

function rounded(value: number, places: number): number {
	const factor = 10 ** places;
	return Math.round(value * factor) / factor;
}

/**
 * Ender Storage feeds this OBJ through CodeChickenLib's `swapYZ`, translates it almost exactly onto
 * the block centre, and takes a backfaced copy so its glass/frame can be seen from either side.
 */
export async function enderStorageBlockModel(blockId: string, resources: ResourceManager): Promise<BlockPackModel | null> {
	if (blockId !== 'enderstorage:ender_tank') {
		return null;
	}
	const source = await resources.getResource('raw', new ResourceLocator('enderstorage', 'models/endertank.obj'));
	if (!source) {
		return null;
	}
	const parsed = parseObj(source.toString('utf8'), true);
	if (parsed.triangles.length === 0) {
		return null;
	}
	const groups = new Map<string, MeshGroup>();
	for (const triangle of parsed.triangles) {
		const object = triangle.object || undefined;
		const key = object ?? '';
		let group = groups.get(key);
		if (!group) {
			group = {
				sprite: 'enderstorage:endertank',
				...(object && { object }),
				positions: [],
				uv: [],
			};
			groups.set(key, group);
		}
		// CCL's backfacedCopy duplicates the reversed triangle. Keep the two faces in the same group.
		for (const order of [[0, 1, 2], [2, 1, 0]] as const) {
			for (const corner of order) {
				const [positionX, positionY, positionZ] = triangle.positions[corner];
				group.positions.push(
					rounded((positionX - 0.0099) * BLOCK_UNITS, 3),
					rounded(positionZ * BLOCK_UNITS, 3),
					rounded((positionY - 0.0027) * BLOCK_UNITS, 3),
				);
				const [textureU, textureV] = triangle.uvs[corner];
				group.uv.push(rounded(textureU * BLOCK_UNITS, 4), rounded(textureV * BLOCK_UNITS, 4));
			}
		}
	}
	return {
		ao: true,
		elements: [],
		particle: 'enderstorage:endertank',
		mesh: groups.values().toArray().toSorted((left, right) => (left.object ?? '').localeCompare(right.object ?? '')),
		renderType: 'cutout',
	};
}
