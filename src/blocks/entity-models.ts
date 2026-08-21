/**
 * Entity geometry for the pack: link each entity to the class that builds it, read that class's
 * bytecode, and stitch the sheets those models are drawn with.
 *
 * The pieces all live in `src/entities/` — this is the part that knows what a *pack* wants. Which is
 * mostly two things the extractor does not care about: several entities share one model (every zombie
 * in the game is a `HumanoidModel`), so models are keyed by class and pointed at rather than copied;
 * and the `uv` values in a model address the entity's own sheet, so those sheets have to be in an
 * atlas the consumer can sample.
 *
 * Needs the *code*, not just the assets. An `--assets` folder has none, and a pack exported from one
 * carries no entity geometry — which is the honest answer rather than a silent gap.
 */

import { findGeoForEntity } from './entity-geo.ts';
import { extractInheritedModel } from '../entities/inherit.ts';
import { buildModelNameIndex, classReader, linkEntityModel } from '../entities/link.ts';
import { MappingsUnavailableError, resolveMappings } from '../entities/mappings.ts';
import { loadModelCode } from '../entities/model-code.ts';

import type { EntityPackModel, EntityPackPart } from './pack-format.ts';
import type { ExtractedModel, Part } from '../entities/model.ts';
import type { ResourceManager } from '../resources/manager.ts';

/** What the exporter needs to read code out of; a jar, in practice. */
export interface ClassSource {
	list: () => Promise<string[]>;
	read: (internalName: string) => Promise<Uint8Array | null>;
}

export interface EntityGeometryResult {
	/** Model id (the class it came from) → geometry. */
	models: Record<string, EntityPackModel>;
	/** Entity id → model id, for the entity table to point with. */
	modelOf: Map<string, string>;
	/** Entity sheets the models address, to be stitched into the pack's own atlas. */
	spriteIds: Set<string>;
	failures: Array<{ id: string; reason: string; }>;
}

function countCubes(part: Part): number {
	return part.cubes.length + part.children.reduce((sum, child) => sum + countCubes(child), 0);
}

/** Drops the internal shape into the pack's, omitting what is at its default. */
function toPackPart(part: Part): EntityPackPart {
	return {
		name: part.name,
		pivot: [...part.pivot],
		rotation: [...part.rotation],
		cubes: part.cubes.map((cube) => {
			return {
				origin: [...cube.origin] as [number, number, number],
				size: [...cube.size] as [number, number, number],
				uv: [...cube.uv] as [number, number],
				...(cube.inflate !== 0 && { inflate: cube.inflate }),
				...(cube.mirror && { mirror: true as const }),
				...(cube.faces && { faces: cube.faces }),
			};
		}),
		children: part.children.map(child => toPackPart(child)),
	};
}

export interface CollectEntityGeometryOptions {
	version: string;
	/** Where mappings cache; the same directory the jars do. */
	cacheDir: string;
	classes: ClassSource;
	/** Entity ids to look for, as the registry named them. */
	entityIds: readonly string[];
	/** The sheet each entity resolved to, from the entity registry, keyed by entity id. */
	textureOf: ReadonlyMap<string, string>;
	/**
	 * The assets, for the mods whose geometry is not in code at all.
	 *
	 * A GeckoLib mob ships Blockbench's bedrock format and registers it by resource location, so there
	 * is nothing for the interpreter to read; `entity-geo.ts` finds and converts it instead.
	 */
	resources?: ResourceManager;
	onProgress?: (done: number, total: number) => void;
}

/**
 * Recovers geometry for as many of `entityIds` as the code describes.
 *
 * Mappings are resolved once: downloaded for an obfuscated jar, and the identity for one that is not
 * (from the 26 line the client ships in the clear, and a mod jar never was obfuscated). A version that
 * is obfuscated *and* unmapped — 1.13.x — yields nothing, with the reason recorded once rather than
 * per entity.
 */
export async function collectEntityGeometry(
	options: CollectEntityGeometryOptions,
): Promise<EntityGeometryResult> {
	const { classes, entityIds } = options;
	const models: Record<string, EntityPackModel> = {};
	const modelOf = new Map<string, string>();
	const spriteIds = new Set<string>();
	const failures: Array<{ id: string; reason: string; }> = [];

	const names = await classes.list();
	let mappings;
	try {
		({ mappings } = await resolveMappings(options.version, options.cacheDir, async () => names));
	} catch (err) {
		failures.push({
			id: options.version,
			reason: err instanceof MappingsUnavailableError
				? `no entity geometry: ${err.message}`
				: `no entity geometry: mappings could not be loaded (${(err as Error).message})`,
		});
		return { models, modelOf, spriteIds, failures };
	}

	/*
	 * The model code of the whole jar, because a model is rarely self-contained: it inherits parts from
	 * its superclass and borrows others from a sibling, and the interpreter needs both to follow the
	 * calls that build them.
	 */
	const code = await loadModelCode(
		names,
		async internal => await classes.read(internal),
		internal => mappings.originalOf.get(internal) ?? internal,
	);
	const extracted = new Map<string, ExtractedModel | null>();
	const geometryOf = async (internal: string): Promise<ExtractedModel | null> => {
		if (!extracted.has(internal)) {
			extracted.set(internal, await extractInheritedModel(internal, async name => await classes.read(name), code));
		}
		return extracted.get(internal) ?? null;
	};
	const context = {
		mappings,
		read: classReader(async internal => await classes.read(internal)),
		hasGeometry: async (internal: string): Promise<boolean> => {
			const model = await geometryOf(internal);
			return model !== null && model.parts.reduce((sum, part) => sum + countCubes(part), 0) > 0;
		},
		// Only a mod needs the fuzzy route; vanilla's named routes are exact
		nameIndex: buildModelNameIndex(names),
	};

	/*
	 * The bedrock fallback, for an entity whose model is not in the code. Tried only where the linker
	 * found no class, so a mod that writes its models in Java is never second-guessed by a name match.
	 */
	const geoFor = async (entityId: string): Promise<{ id: string; model: ExtractedModel; } | null> => {
		if (!options.resources) {
			return null;
		}
		const [namespace, name] = entityId.includes(':') ? entityId.split(':') : ['minecraft', entityId];
		return await findGeoForEntity(options.resources, namespace, name);
	};

	let done = 0;
	for (const entityId of [...entityIds].toSorted((left, right) => left.localeCompare(right))) {
		options.onProgress?.(++done, entityIds.length);
		const link = await linkEntityModel(entityId, context);
		const found = link
			? { id: link.className, model: await geometryOf(link.obfuscated) }
			: await geoFor(entityId);
		if (!found?.model) {
			continue;
		}
		const { id: modelId, model } = found;
		// Keyed by where it came from, so the twenty entities that share `HumanoidModel` share one entry
		if (!models[modelId]) {
			models[modelId] = {
				textureSize: [...model.textureSize] as [number, number],
				parts: model.parts.map(part => toPackPart(part)),
				...(model.notes.length > 0 && { notes: [...model.notes] }),
			};
		}
		modelOf.set(entityId, modelId);
		const texture = options.textureOf.get(entityId);
		if (texture) {
			spriteIds.add(texture);
		} else {
			/*
			 * Geometry with no sheet draws in the missing texture. Worth saying: the shape is right and
			 * only the skin is absent, which is a different problem from having no model at all.
			 */
			failures.push({ id: entityId, reason: `geometry recovered from ${modelId} but no entity texture resolved` });
		}
	}

	return { models, modelOf, spriteIds, failures };
}
