/** GeckoLib block geometry selected by a Java block-entity renderer rather than its placeholder JSON. */

import { geoToFaces, parseGeo } from '../render/geo.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { MeshGroup } from './obj-mesh.ts';
import type { BlockPackModel } from './pack-format.ts';
import type { ResourceManager } from '../resources/manager.ts';

interface GeoBlockResource {
	geo: string;
	texture: string;
}

/** Blocks whose ordinary cube model exists only for particles/breaking and is replaced in Java. */
const GEO_BLOCKS: Readonly<Record<string, GeoBlockResource>> = {
	'ars_nouveau:arcane_core': {
		geo: 'ars_nouveau:geo/arcane_core.geo.json',
		texture: 'ars_nouveau:block/arcane_core',
	},
	'ars_nouveau:enchanting_apparatus': {
		geo: 'ars_nouveau:geo/enchanting_apparatus.geo.json',
		texture: 'ars_nouveau:block/enchanting_apparatus',
	},
	'ars_nouveau:imbuement_chamber': {
		geo: 'ars_nouveau:geo/imbuement_chamber.geo.json',
		texture: 'ars_nouveau:block/imbuement_chamber',
	},
};

const TRIANGLE_CORNERS = [0, 1, 2, 0, 2, 3] as const;

/** Converts the already-flattened Gecko quads into the block pack's 0–16 triangle mesh. */
export async function geoBlockModel(blockId: string, resources: ResourceManager): Promise<BlockPackModel | null> {
	const resource = GEO_BLOCKS[blockId];
	if (!resource) {
		return null;
	}
	const raw = await resources.getResource('raw', ResourceLocator.parse(resource.geo));
	if (!raw) {
		return null;
	}
	const geo = parseGeo(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
	if (!geo) {
		return null;
	}
	const group: MeshGroup = { sprite: resource.texture, positions: [], uv: [] };
	for (const face of geoToFaces(geo)) {
		const uvs = [
			[face.uv1[0], face.uv1[1]],
			[face.uv1[0], face.uv2[1]],
			[face.uv2[0], face.uv2[1]],
			[face.uv2[0], face.uv1[1]],
		] as const;
		for (const corner of TRIANGLE_CORNERS) {
			group.positions.push(...face.vertices[corner].map(value => value * 16));
			group.uv.push(uvs[corner][0] * 16, uvs[corner][1] * 16);
		}
	}
	if (group.positions.length === 0) {
		return null;
	}
	return {
		ao: false,
		elements: [],
		mesh: [group],
		particle: resource.texture,
		renderType: 'cutout',
	};
}
