/** GeckoLib block geometry selected by a Java block-entity renderer rather than its placeholder JSON. */

import { geoToFaces, parseGeo } from '../render/geo.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { MeshGroup } from './obj-mesh.ts';
import type { BlockPackModel } from './pack-format.ts';
import type { ResourceManager } from '../resources/manager.ts';

interface GeoBlockResource {
	geo: string;
	texture: string;
	/** The blockstate has no rotations because GeckoLib reads `facing` in Java. */
	javaFacing?: boolean;
}

export interface GeoBlockOverride {
	model: BlockPackModel;
	javaFacing: boolean;
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

/* `geoToFaces` is wound for the software rasterizer; pack meshes are WebGL-style CCW from outside. */
const TRIANGLE_CORNERS = [0, 2, 1, 0, 3, 2] as const;

/**
 * Exact convention used by GeckoLib block renderers such as Oritech's: the block, geometry and skin
 * share a name. Requiring both assets avoids treating an unrelated same-named entity geo as a block.
 */
async function conventionalResource(blockId: string, resources: ResourceManager): Promise<GeoBlockResource | null> {
	const block = ResourceLocator.parse(blockId);
	const resource = {
		geo: `${block.namespace}:geo/block/models/${block.path}.geo.json`,
		texture: `${block.namespace}:block/models/${block.path}`,
		javaFacing: true,
	};
	const [geo, texture] = await Promise.all([
		resources.hasResource('raw', ResourceLocator.parse(resource.geo)),
		resources.hasResource('texture', ResourceLocator.parse(resource.texture)),
	]);
	return geo && texture ? resource : null;
}

/** Converts a Java-rendered Gecko block into a world-scale 0–16 triangle mesh. */
export async function geoBlockModel(blockId: string, resources: ResourceManager): Promise<GeoBlockOverride | null> {
	const resource = GEO_BLOCKS[blockId] ?? await conventionalResource(blockId, resources);
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
	for (const face of geoToFaces(geo, { fit: false })) {
		const uvs = face.uvs ?? [
			[face.uv1[0], face.uv1[1]],
			[face.uv1[0], face.uv2[1]],
			[face.uv2[0], face.uv2[1]],
			[face.uv2[0], face.uv1[1]],
		] as const;
		for (const corner of TRIANGLE_CORNERS) {
			const vertex = face.vertices[corner];
			// GeckoLib places the Bedrock origin at the centre of the block's X/Z plane.
			group.positions.push(vertex[0] + 8, vertex[1], vertex[2] + 8);
			group.uv.push(uvs[corner][0] * 16, uvs[corner][1] * 16);
		}
	}
	if (group.positions.length === 0) {
		return null;
	}
	return {
		model: {
			ao: false,
			elements: [],
			mesh: [group],
			particle: resource.texture,
			renderType: 'cutout',
		},
		javaFacing: resource.javaFacing ?? false,
	};
}
