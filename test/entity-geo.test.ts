/**
 * Bedrock `.geo.json` geometry, converted into the model a Java class would have produced.
 *
 * The whole thing rests on one coordinate conversion, and a wrong sign in it produces a mob that is
 * upside down, mirrored, or twisted at one joint — all of which validate perfectly against the schema
 * and look like a renderer bug. So it is checked against something that already draws these models:
 * `geoToFaces` rasterises bedrock geometry for GeckoLib *item* icons in production, so its corner
 * positions are the oracle, and every geometry file in four real mods has to agree with it exactly.
 *
 * Mods are downloaded at test time (Modrinth, cached under `.work/fixtures/modrinth/`) like the vanilla
 * jars: nothing license-restricted is committed. `RENDERMITE_SKIP_ONLINE=1` skips the lot.
 */

import { describe, expect, it } from 'vitest';

import { ensureModrinthJar, ensureVanillaJar, fixturesDir } from './fixtures/index.ts';
import { findGeoForEntity } from '../src/blocks/entity-geo.ts';
import { collectEntityGeometry } from '../src/blocks/entity-models.ts';
import { geoToModel } from '../src/entities/geo-model.ts';
import { JarClassReader } from '../src/entities/jar-classes.ts';
import { geoToFaces, parseGeo } from '../src/render/geo.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { ResourceLocator } from '../src/resources/locator.ts';

import type { ModrinthSpec } from './fixtures/index.ts';
import type { EntityPackCube, EntityPackPart } from '../src/blocks/pack-format.ts';
import type { Part } from '../src/entities/model.ts';
import type { ParsedGeo } from '../src/render/geo.ts';

type Vec = [number, number, number];

const online = process.env.RENDERMITE_SKIP_ONLINE !== '1';

/** Four GeckoLib mods, spanning both layouts: `geo/entity/` and a flat `geo/`. */
const MODS: Record<string, ModrinthSpec> = {
	occultism: { slug: 'occultism', gameVersion: '1.21.1', loader: 'neoforge' },
	creeperOverhaul: { slug: 'creeper-overhaul', gameVersion: '1.21.1', loader: 'neoforge' },
	arsNouveau: { slug: 'ars-nouveau', gameVersion: '1.21.1', loader: 'neoforge' },
	aquaticFrontiers: { slug: 'aquatic-frontiers', gameVersion: '1.21.1', loader: 'neoforge' },
};

async function openMod(spec: ModrinthSpec): Promise<JarResourceManager> {
	return new JarResourceManager(await ensureModrinthJar(spec));
}

/** Every `.geo.json` in a jar, parsed. */
async function geometryIn(resources: JarResourceManager): Promise<Array<{ path: string; geo: ParsedGeo; }>> {
	const out: Array<{ path: string; geo: ParsedGeo; }> = [];
	for (const namespace of await resources.listNamespaces()) {
		for (const locator of await resources.listResources('raw', namespace)) {
			if (!locator.path.endsWith('.geo.json')) {
				continue;
			}
			const raw = await resources.getResource('raw', locator);
			if (!raw) {
				continue;
			}
			try {
				const geo = parseGeo(JSON.parse(raw.toString('utf8')) as Record<string, unknown>);
				if (geo) {
					out.push({ path: locator.path, geo });
				}
			} catch {
				continue;
			}
		}
	}
	return out;
}

/** Vanilla's `ModelPart.translateAndRotate`: to the pivot, then rotate about z, then y, then x. */
function spin(point: Vec, rotation: Vec): Vec {
	let [across, up, along] = point;
	const [pitch, yaw, roll] = rotation;
	[across, up] = [across * Math.cos(roll) - up * Math.sin(roll), across * Math.sin(roll) + up * Math.cos(roll)];
	[across, along] = [across * Math.cos(yaw) + along * Math.sin(yaw), -across * Math.sin(yaw) + along * Math.cos(yaw)];
	[up, along] = [up * Math.cos(pitch) - along * Math.sin(pitch), up * Math.sin(pitch) + along * Math.cos(pitch)];
	return [across, up, along];
}

/** Every cube corner of a model, each part's frame composed onto its parent's, in model space. */
function corners(parts: Part[]): Vec[] {
	const out: Vec[] = [];
	const walk = (part: Part, place: (point: Vec) => Vec): void => {
		const here = (local: Vec): Vec => {
			const spun = spin(local, part.rotation);
			return place([spun[0] + part.pivot[0], spun[1] + part.pivot[1], spun[2] + part.pivot[2]]);
		};
		for (const cube of part.cubes) {
			const grow = cube.inflate;
			for (const dx of [0, 1]) {
				for (const dy of [0, 1]) {
					for (const dz of [0, 1]) {
						out.push(here([
							cube.origin[0] - grow + dx * (cube.size[0] + grow * 2),
							cube.origin[1] - grow + dy * (cube.size[1] + grow * 2),
							cube.origin[2] - grow + dz * (cube.size[2] + grow * 2),
						]));
					}
				}
			}
		}
		for (const child of part.children) {
			walk(child, here);
		}
	};
	for (const part of parts) {
		walk(part, point => point);
	}
	return out;
}

/** The unit-cube fit `geoToFaces` applies, so the two clouds are in the same space. */
function fit(points: Vec[]): Vec[] {
	const min: Vec = [Infinity, Infinity, Infinity];
	const max: Vec = [-Infinity, -Infinity, -Infinity];
	for (const point of points) {
		for (let axis = 0; axis < 3; axis++) {
			min[axis] = Math.min(min[axis], point[axis]);
			max[axis] = Math.max(max[axis], point[axis]);
		}
	}
	const extent = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
	const centre: Vec = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
	return points.map(point => point.map((value, axis) => (value - centre[axis]) / extent + 0.5) as Vec);
}

/** A point on the far edge rounds to -0 on one side and 0 on the other, and -0 + 0 is still -0. */
function key(point: Vec): string {
	return point
		.map((value) => {
			const rounded = Number(value.toFixed(4));
			return (rounded === 0 ? 0 : rounded).toFixed(4);
		})
		.join(',');
}

/** Corners of a converted model, mapped to where the renderer draws them: `(-x, 24 - y, z)`. */
function drawnAt(geo: ParsedGeo): Set<string> {
	const model = geoToModel(geo);
	const placed = corners(model.parts).map(point => [-point[0], 24 - point[1], point[2]] as Vec);
	return new Set(fit(placed).map(point => key(point)));
}

/** Which of the trusted evaluator's corners the conversion fails to put in the same place. */
function disagreements(geo: ParsedGeo): number {
	const drawn = drawnAt(geo);
	// geoToFaces already returns unit-fitted vertices, so they need no second fit
	return geoToFaces(geo).flatMap(face => face.vertices as Vec[]).filter(point => !drawn.has(key(point))).length;
}

describe('geoToModel', () => {
	/**
	 * The conversion by hand, on one bone with one cube.
	 *
	 * Bedrock is authored y-up from the mob's feet; a `ModelPart` is y-down from 1.5 blocks (24 pixels)
	 * above them. So a bedrock pivot at y 6 becomes 18, and a box's origin — its *minimum* corner in
	 * bedrock — is measured from the far side after the flip: `pivot.y - origin.y - size.y`.
	 */
	it('flips y about the feet and states the box relative to the pivot', () => {
		const model = geoToModel({
			textureWidth: 64,
			textureHeight: 32,
			bones: [{
				name: 'leg',
				pivot: [4, 6, -5],
				cubes: [{ origin: [2, 0, -8], size: [5, 7, 5], uv: [0, 33], inflate: 0.25, mirror: true }],
			}],
		});

		expect(model.textureSize).toStrictEqual([64, 32]);
		expect(model.parts).toHaveLength(1);
		const leg = model.parts[0];
		expect(leg.name).toBe('leg');
		expect(leg.pivot).toStrictEqual([4, 18, -5]);
		expect(leg.rotation).toStrictEqual([0, 0, 0]);
		// x and z unchanged and relative to the pivot; y from the far corner: 6 - 0 - 7
		expect(leg.cubes[0].origin).toStrictEqual([-2, -1, -3]);
		expect(leg.cubes[0].size).toStrictEqual([5, 7, 5]);
		expect(leg.cubes[0].uv).toStrictEqual([0, 33]);
		expect(leg.cubes[0].inflate).toBe(0.25);
		expect(leg.cubes[0].mirror).toBe(true);
	});

	/**
	 * Bedrock states degrees; a `ModelPart` states radians. The y flip is a mirror, so it reverses the
	 * rotations about x and z, and bedrock's own convention already reverses those about x and y: the two
	 * compose to `[x, -y, -z]`. The corpus test below is what proves it, but pinning the numbers here is
	 * what tells you *which* sign moved when it breaks.
	 */
	it('converts degrees to radians, reversing y and z', () => {
		const [bone] = geoToModel({
			textureWidth: 16,
			textureHeight: 16,
			bones: [{ name: 'arm', pivot: [0, 0, 0], rotation: [90, 45, -30], cubes: [] }],
		}).parts;

		expect(bone.rotation[0]).toBeCloseTo(Math.PI / 2, 10);
		expect(bone.rotation[1]).toBeCloseTo(-Math.PI / 4, 10);
		expect(bone.rotation[2]).toBeCloseTo(Math.PI / 6, 10);
	});

	/** A bone's pivot is absolute in bedrock and relative to its parent in a `ModelPart`. */
	it('makes a child pivot relative to its parent', () => {
		const model = geoToModel({
			textureWidth: 16,
			textureHeight: 16,
			bones: [
				{ name: 'body', pivot: [0, 12, 0], cubes: [] },
				{ name: 'head', parent: 'body', pivot: [0, 20, -2], cubes: [] },
			],
		});

		expect(model.parts).toHaveLength(1);
		const [body] = model.parts;
		const [head] = body.children;
		expect(body.pivot).toStrictEqual([0, 12, 0]);
		// 24 - 20 = 4 against the parent's 24 - 12 = 12
		expect(head.pivot).toStrictEqual([0, -8, -2]);
	});

	/**
	 * A bedrock cube can rotate on its own, about its own pivot, and 18% of the corpus's do. A `Cube`
	 * has nowhere to put a rotation, so it becomes a part of its own — which is exactly what a
	 * `ModelPart` with one box is.
	 */
	it('gives a rotated cube a part of its own to rotate with', () => {
		const [bone] = geoToModel({
			textureWidth: 16,
			textureHeight: 16,
			bones: [{
				name: 'spike',
				pivot: [0, 10, 0],
				cubes: [{ origin: [0, 8, 0], size: [2, 2, 2], pivot: [1, 9, 1], rotation: [0, 0, 45] }],
			}],
		}).parts;

		expect(bone.cubes).toHaveLength(0);
		expect(bone.children).toHaveLength(1);
		const [spun] = bone.children;
		expect(spun.pivot).toStrictEqual([1, 1, 1]);
		expect(spun.rotation[2]).toBeCloseTo(-Math.PI / 4, 10);
		expect(spun.cubes[0].size).toStrictEqual([2, 2, 2]);
	});

	/**
	 * Java has no per-face texture rects: `addBox` always unwraps a box the same way. Bedrock does, and
	 * 56% of the corpus's cubes use them, so they are carried through rather than flattened — a consumer
	 * that drops them draws over half of every modded mob from the wrong part of the sheet.
	 */
	it('carries per-face texture rects through, defaulting an omitted size', () => {
		const [bone] = geoToModel({
			textureWidth: 64,
			textureHeight: 64,
			bones: [{
				name: 'fin',
				pivot: [0, 0, 0],
				cubes: [{
					origin: [0, 0, 0],
					size: [3, 4, 5],
					uv: { north: { uv: [10, 20], uv_size: [3, 4] }, up: { uv: [30, 40] } },
				}],
			}],
		}).parts;

		expect(bone.cubes[0].faces?.north).toStrictEqual({ uv: [10, 20], size: [3, 4] });
		// An omitted uv_size is the face's own pixel extent
		expect(bone.cubes[0].faces?.up).toStrictEqual({ uv: [30, 40], size: [3, 4] });
		expect(bone.cubes[0].faces?.south).toBeUndefined();
	});

	/** A bone naming a parent the file never defines is kept as a root rather than dropped. */
	it('keeps a bone whose parent is missing, and says so', () => {
		const model = geoToModel({
			textureWidth: 16,
			textureHeight: 16,
			bones: [{ name: 'tail', parent: 'nothing', pivot: [0, 4, 0], cubes: [] }],
		});

		expect(model.parts).toHaveLength(1);
		expect(model.parts[0].pivot).toStrictEqual([0, 20, 0]);
		expect(model.notes).toStrictEqual([
			'tail names a parent the file does not define, so it hangs from the model root',
		]);
	});
});

describe.skipIf(!online)('against the evaluator that already draws these models', () => {
	/**
	 * Every geometry file in four GeckoLib mods, converted and evaluated with vanilla's own part
	 * semantics, has to land every corner exactly where `geoToFaces` puts it. That covers nested bones,
	 * bone and cube rotations, inflate, and the multi-root files — 135 files, ~2,100 cubes.
	 */
	it('puts every corner of every model in the same place', { timeout: 300000 }, async () => {
		let files = 0;
		const wrong: string[] = [];
		for (const spec of Object.values(MODS)) {
			const resources = await openMod(spec);
			for (const { path, geo } of await geometryIn(resources)) {
				if (geoToFaces(geo).length === 0) {
					continue;
				}
				files++;
				const missed = disagreements(geo);
				if (missed > 0) {
					wrong.push(`${spec.slug} ${path}: ${missed} corners`);
				}
			}
		}

		expect(files).toBeGreaterThanOrEqual(135);
		expect(wrong).toStrictEqual([]);
	});

	/**
	 * And no other sign convention does. Negating a rotation in the *input* is the same as negating it in
	 * the conversion, since the conversion is linear in it — so this sweeps all eight combinations
	 * against the oracle and asserts only the one in use agrees. Without this the correct signs look
	 * like a guess that happened to work.
	 */
	it('is the only sign convention that agrees', { timeout: 300000 }, async () => {
		const resources = await openMod(MODS.occultism);
		const files = await geometryIn(resources);
		const spun = files.filter(entry => entry.geo.bones.some(bone => bone.rotation?.some(value => value !== 0)));
		expect(spun.length).toBeGreaterThan(0);

		const agreed = new Map<string, number>();
		for (const signs of [[1, 1, 1], [1, 1, -1], [1, -1, 1], [1, -1, -1], [-1, 1, 1], [-1, 1, -1], [-1, -1, 1], [-1, -1, -1]]) {
			let matches = 0;
			for (const { geo } of spun) {
				const altered: ParsedGeo = {
					...geo,
					bones: geo.bones.map((bone) => {
						return {
							...bone,
							rotation: bone.rotation?.map((value, axis) => value * signs[axis]),
							cubes: bone.cubes?.map((cube) => {
								return {
									...cube,
									rotation: cube.rotation?.map((value, axis) => value * signs[axis]),
								};
							}),
						};
					}),
				};
				// The oracle always reads the original file; only the conversion's input is flipped
				const drawn = drawnAt(altered);
				const trusted = geoToFaces(geo).flatMap(face => face.vertices as Vec[]);
				if (trusted.every(point => drawn.has(key(point)))) {
					matches++;
				}
			}
			agreed.set(signs.map(sign => (sign > 0 ? '+' : '-')).join(''), matches);
		}

		expect(agreed.get('+++')).toBe(spun.length);
		for (const [signs, matches] of agreed) {
			if (signs !== '+++') {
				expect(matches, `${signs} should not agree`).toBeLessThan(spun.length);
			}
		}
	});

	/**
	 * An oracle from the game rather than from our own code. Creeper Overhaul's creepers keep vanilla's
	 * skeleton, and a vanilla creeper's legs pivot at y 18 with 4x6x4 boxes. Its geometry states y 6,
	 * which is the same joint measured the other way up: 24 - 6 = 18.
	 */
	it('lands a creeper variant where vanilla puts a creeper', { timeout: 120000 }, async () => {
		const resources = await openMod(MODS.creeperOverhaul);
		const raw = await resources.getResource('raw', new ResourceLocator('creeperoverhaul', 'geo/badlands.geo.json'));
		const geo = parseGeo(JSON.parse((raw as Buffer).toString('utf8')) as Record<string, unknown>) as ParsedGeo;
		const model = geoToModel(geo);

		// A pivot is relative to its parent, so the joint's own height is the chain added up
		const absolute = new Map<string, number>();
		const walk = (part: Part, above: number): void => {
			absolute.set(part.name, above + part.pivot[1]);
			for (const child of part.children) {
				walk(child, above + part.pivot[1]);
			}
		};
		for (const part of model.parts) {
			walk(part, 0);
		}
		const legs = [...absolute].filter(([name]) => name.startsWith('leg'));
		expect(legs).toHaveLength(4);
		for (const [name, height] of legs) {
			expect(height, name).toBe(18);
		}
		/*
		 * And it stands on the ground: y 24 is where a `ModelPart` origin sits. Measured against the
		 * file's own floor, because this creeper's fluffy overlay is a second box inflated by 2.
		 */
		const floor = Math.min(...geo.bones
			.flatMap(bone => bone.cubes ?? [])
			.map(cube => (cube.origin?.[1] ?? 0) - (cube.inflate ?? 0)));
		expect(floor).toBeLessThan(0);
		expect(Math.max(...corners(model.parts).map(point => point[1]))).toBe(24 - floor);
	});

	/**
	 * Bedrock authors a mob standing on y 0, so a converted one has to stand on 24 — the height a
	 * `ModelPart` origin sits at — and rise from there. This is the assertion an inverted flip fails
	 * even when everything is internally consistent, which is why it is stated against the raw file
	 * rather than against our own evaluation of it.
	 *
	 * Only the files without rotations, since a rotated box can reach below the foot it hangs from and
	 * accounting for that here would just be restating the conversion.
	 */
	it('stands every mob on the ground it was authored on', { timeout: 300000 }, async () => {
		const wrong: string[] = [];
		let onTheGround = 0;
		for (const spec of Object.values(MODS)) {
			const resources = await openMod(spec);
			for (const { path, geo } of await geometryIn(resources)) {
				const spun = geo.bones.some(bone => bone.rotation?.some(value => value !== 0)
					|| bone.cubes?.some(cube => cube.rotation?.some(value => value !== 0)));
				const boxes = geo.bones.flatMap(bone => bone.cubes ?? []);
				if (spun || boxes.length === 0) {
					continue;
				}
				// min(origin, origin + size) because a negative size means the box grows downwards
				const lowest = Math.min(...boxes.map((cube) => {
					const from = cube.origin?.[1] ?? 0;
					return Math.min(from, from + (cube.size?.[1] ?? 0)) - (cube.inflate ?? 0);
				}));
				const highest = Math.max(...corners(geoToModel(geo).parts).map(point => point[1]));
				if (highest !== 24 - lowest) {
					wrong.push(`${spec.slug} ${path}: ${highest} for a floor of ${lowest}`);
				}
				if (lowest === 0) {
					onTheGround++;
				}
			}
		}

		expect(onTheGround).toBeGreaterThan(20);
		expect(wrong).toStrictEqual([]);
	});
});

describe.skipIf(!online)('findGeoForEntity', () => {
	/**
	 * A mod's entity id and its geometry's filename agree less often than you would hope. Each of these
	 * is a real mod's spelling, and between them they are worth 16 of the 54 mobs the modpack corpus
	 * gets this way — half of Ars Nouveau's.
	 */
	it('finds the geometry through the ways a mod spells its own names', { timeout: 120000 }, async () => {
		const resources = await openMod(MODS.arsNouveau);
		const idOf = async (name: string): Promise<string | undefined> => {
			const found = await findGeoForEntity(resources, 'ars_nouveau', name);
			return found?.id;
		};

		// Registered `bookwyrm`, shipped as `book_wyrm.geo.json`
		expect(await idOf('bookwyrm')).toBe('ars_nouveau:geo/book_wyrm.geo.json');
		// A decorated entity drawn by the plain model
		expect(await idOf('familiar_drygmy')).toBe('ars_nouveau:geo/drygmy.geo.json');
		expect(await idOf('wilden_hunter')).toBe('ars_nouveau:geo/wilden_hunter.geo.json');
	});

	/** Occultism registers `foliot` and ships only its jobs, so any foliot will do — the shortest wins. */
	it('falls back to a variant of the same mob', { timeout: 120000 }, async () => {
		const resources = await openMod(MODS.occultism);
		const found = await findGeoForEntity(resources, 'occultism', 'foliot');

		expect(found?.id).toMatch(/^occultism:geo\/entity\/foliot_\w+\.geo\.json$/);
		expect(found?.model.parts.length).toBeGreaterThan(0);
	});

	/** And nothing is invented for an entity the mod ships no geometry for. */
	it('finds nothing rather than somebody else, for a name it does not have', { timeout: 120000 }, async () => {
		const resources = await openMod(MODS.occultism);

		expect(await findGeoForEntity(resources, 'occultism', 'spell_projectile')).toBeNull();
		expect(await findGeoForEntity(resources, 'occultism', 'cow')).toBeNull();
	});

	/**
	 * Per-mod floors, the same guarantee the vanilla matrix keeps: this many mobs still come out. Ars
	 * Nouveau and Occultism are the two that motivated the name matching, and Creeper Overhaul is the
	 * one whose files sit in a flat `geo/`.
	 */
	const COVERAGE = [
		{ mod: 'arsNouveau', namespace: 'ars_nouveau', names: ['bookwyrm', 'drygmy', 'starbuncle', 'wixie', 'whirlisprig', 'wilden_chimera'] },
		{ mod: 'occultism', namespace: 'occultism', names: ['afrit', 'marid', 'djinni', 'foliot', 'demonic_wife'] },
		{ mod: 'creeperOverhaul', namespace: 'creeperoverhaul', names: ['badlands', 'bamboo', 'cave', 'desert'] },
		{ mod: 'aquaticFrontiers', namespace: 'aquatic_frontiers', names: ['coralcrab', 'coralgolem', 'giantsquid'] },
	];

	it.each(COVERAGE)('recovers the named mobs of $namespace', { timeout: 300000 }, async (testCase) => {
		const resources = await openMod(MODS[testCase.mod]);
		for (const name of testCase.names) {
			const found = await findGeoForEntity(resources, testCase.namespace, name);
			expect(found, name).not.toBeNull();
			expect(found?.model.parts.length, name).toBeGreaterThan(0);
		}
	});
});

describe.skipIf(!online)('the pack collector', () => {
	/**
	 * The wiring, not just the finder: geometry is only looked for in the assets once the *code* has
	 * nothing to offer, so a mod that writes its models in Java is never second-guessed by a name match.
	 * Classes come from the vanilla jar the way a real export supplies them.
	 */
	it('falls back to bedrock geometry for the entities no class describes', { timeout: 300000 }, async () => {
		const classes = new JarClassReader(await ensureVanillaJar('1.21.1'));
		try {
			const collected = await collectEntityGeometry({
				version: '1.21.1',
				cacheDir: fixturesDir,
				classes,
				entityIds: ['occultism:afrit', 'occultism:marid', 'occultism:spell_projectile', 'minecraft:cow'],
				textureOf: new Map(),
				resources: await openMod(MODS.occultism),
			});

			expect(collected.modelOf.get('occultism:afrit')).toBe('occultism:geo/entity/afrit.geo.json');
			expect(collected.modelOf.get('occultism:marid')).toBe('occultism:geo/entity/marid.geo.json');
			// Nothing invented for a projectile the mod ships no geometry for
			expect(collected.modelOf.has('occultism:spell_projectile')).toBe(false);
			// And the vanilla cow still comes from the code, not from a name that happens to match
			expect(collected.modelOf.get('minecraft:cow')).toBe('net.minecraft.client.model.CowModel');

			const afrit = collected.models['occultism:geo/entity/afrit.geo.json'];
			expect(afrit.parts.length).toBeGreaterThan(0);
			expect(afrit.textureSize).toStrictEqual([64, 64]);
			// Per-face rects survive into the pack shape, which is where a consumer reads them
			const everyCube = (part: EntityPackPart): EntityPackCube[] => [
				...part.cubes,
				...part.children.flatMap(child => everyCube(child)),
			];
			const marid = collected.models['occultism:geo/entity/marid.geo.json'];
			const withFaces = marid.parts.flatMap(part => everyCube(part)).filter(cube => cube.faces);
			expect(withFaces.length).toBeGreaterThan(0);
			expect(Object.keys(withFaces[0].faces ?? {}).length).toBeGreaterThan(0);
		} finally {
			await classes.close();
		}
	});
});
