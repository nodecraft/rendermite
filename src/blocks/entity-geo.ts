/**
 * Finding the `.geo.json` a GeckoLib entity is drawn from.
 *
 * The registration is in Java — `GeoModel.getModelResource` returns a resource location — so there is
 * no data to read it out of, and this is a search by name. The same problem `findGeoForItem` solves for
 * items, with the directories a *mob* is filed under instead: `geo/entity/` if the mod is tidy, a flat
 * `geo/` if not (Creeper Overhaul, Ars Nouveau and Aquatic Frontiers all are).
 *
 * The search never leaves a `geo` directory, and every rule below is a name test rather than a
 * similarity score, so the worst case is finding nothing rather than drawing a mob as another one.
 */

import { geoToModel } from '../entities/geo-model.ts';
import { nameTokens, parseGeo } from '../render/geo.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type { ExtractedModel } from '../entities/model.ts';
import type { ResourceManager } from '../resources/manager.ts';

/** Where a mod keeps entity geometry, in the order worth trying. */
const GEO_DIRECTORIES = ['geo/entity', 'geo', 'geckolib/geo/entity', 'geckolib/geo', 'geo/entities'];

/** A geo path under some `geo` directory, for the scan that runs when the conventional spots miss. */
const UNDER_GEO = /(?:^|\/)(?:geo|geckolib\/geo)\//;

export interface GeoEntityModel {
	/** Model id: the resource that produced it, which is also what makes it unique in the pack. */
	id: string;
	model: ExtractedModel;
}

/**
 * The geometry for one entity, or null when the mod does not ship any under that name.
 *
 * `namespace` and `name` come from the entity id, so `occultism:afrit` looks for
 * `assets/occultism/geo/entity/afrit.geo.json` and its neighbours. Nothing is inferred from the
 * *class* here: a GeckoLib mob has no model class to inspect.
 */
export async function findGeoForEntity(
	resources: ResourceManager,
	namespace: string,
	name: string,
): Promise<GeoEntityModel | null> {
	const paths = GEO_DIRECTORIES.map(directory => `${directory}/${name}.geo.json`);
	for (const path of paths) {
		const found = await load(resources, namespace, path);
		if (found) {
			return found;
		}
	}
	/*
	 * Mods nest geometry under subtrees of their own (`geo/entity/boss/`, `geo/mobs/`), so fall back to
	 * any file of exactly this name under a geo directory. Shortest path first, so a top-level file
	 * beats one buried in a variant folder.
	 */
	const listed = await resources.listResources('raw', namespace);
	const files = listed
		.map(candidate => candidate.path)
		.filter(path => path.endsWith('.geo.json') && UNDER_GEO.test(path))
		.toSorted((left, right) => left.length - right.length);
	for (const path of ranked(files, name)) {
		const found = await load(resources, namespace, path);
		if (found) {
			return found;
		}
	}
	return null;
}

const baseName = (path: string): string => path.split('/').pop()?.replace(/\.geo\.json$/, '') ?? '';

/**
 * The geo files that could be this entity's, best first.
 *
 * A mod's entity id and its geometry's filename agree less often than you would hope, and they
 * disagree in three shapes, each of which is here because a real mod does it:
 *
 * 1. **The same name spelled differently.** Ars Nouveau registers `bookwyrm` and ships
 *    `book_wyrm.geo.json`.
 * 2. **A decorated entity, the plain model.** `familiar_drygmy` is drawn by `drygmy`, and
 *    `marid_unbound` by `marid`. So a geo whose every token appears in the entity's name qualifies,
 *    most specific first — a subset test rather than a similarity score, so an unrelated model can
 *    never win.
 * 3. **A plain entity, a decorated model.** Occultism registers `foliot` and ships only its jobs:
 *    `foliot_worker`, `foliot_crusher`, `foliot_lumberjack`. Any of them is a foliot, so the shortest
 *    wins. Last, because this is the one direction that is a guess.
 */
function ranked(files: string[], name: string): string[] {
	const flattened = name.replaceAll('_', '');
	const wanted = new Set(nameTokens(name));
	const exact = files.filter(path => baseName(path) === name);
	const spelling = files.filter(path => baseName(path).replaceAll('_', '') === flattened);
	const decorated = files
		.filter((path) => {
			const tokens = nameTokens(baseName(path));
			return tokens.length > 0 && tokens.every(token => wanted.has(token));
		})
		.toSorted((left, right) => nameTokens(baseName(right)).length - nameTokens(baseName(left)).length);
	const variants = files.filter((path) => {
		const tokens = new Set(nameTokens(baseName(path)));
		return wanted.isSubsetOf(tokens);
	});
	return [...new Set([...exact, ...spelling, ...decorated, ...variants])];
}

async function load(
	resources: ResourceManager,
	namespace: string,
	path: string,
): Promise<GeoEntityModel | null> {
	const raw = await resources.getResource('raw', new ResourceLocator(namespace, path));
	if (!raw) {
		return null;
	}
	let model: ExtractedModel;
	try {
		const geo = parseGeo(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
		if (!geo) {
			return null;
		}
		model = geoToModel(geo);
	} catch {
		return null;
	}
	return model.parts.length > 0 ? { id: `${namespace}:${path}`, model } : null;
}
