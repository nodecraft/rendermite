/**
 * Recovering entity geometry from bytecode, against real client jars.
 *
 * Entity models are Java code at every version — no jar has ever shipped one as data — so this is the
 * only way to get a mob's shape automatically. Which makes the tests below the whole guarantee: if the
 * interpreter drifts, a pack ships boxes that are subtly the wrong size and nothing else notices.
 *
 * The cow is the anchor. Its numbers are checkable against the game by hand, they have not changed in
 * a decade, and they come out of an *obfuscated* class — so getting them right exercises the mapping,
 * the linkage, the class reader and the interpreter at once.
 */
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { vanillaJar } from './fixtures/index.ts';
import { parseClassFile } from '../src/entities/classfile.ts';
import { extractInheritedModel } from '../src/entities/inherit.ts';
import { JarClassReader, layeredClasses } from '../src/entities/jar-classes.ts';
import { NO_MODEL, classReader, linkEntityModel } from '../src/entities/link.ts';
import {
	identityMappings,
	isObfuscated,
	parseMappings,
	resolveMappings,
} from '../src/entities/mappings.ts';
import { mergeModels } from '../src/entities/merge.ts';
import { loadModelCode } from '../src/entities/model-code.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { ResourceLocator } from '../src/resources/locator.ts';

import type { ExtractedModel, Part } from '../src/entities/model.ts';

const mappingCache = path.join(import.meta.dirname, '..', '.work', 'fixtures');

function countCubes(part: Part): number {
	return part.cubes.length + part.children.reduce((sum, child) => sum + countCubes(child), 0);
}
const cubesOf = (model: ExtractedModel): number => model.parts.reduce((sum, part) => sum + countCubes(part), 0);
const bonesOf = (part: Part): string[] => [part.name, ...part.children.flatMap(child => bonesOf(child))];

/** Every cube of a model, flattened, with the part that owns it. */
function allCubes(model: ExtractedModel): Array<{ part: string; cube: Part['cubes'][number]; }> {
	const out: Array<{ part: string; cube: Part['cubes'][number]; }> = [];
	const walk = (part: Part): void => {
		for (const cube of part.cubes) {
			out.push({ part: part.name, cube });
		}
		for (const child of part.children) {
			walk(child);
		}
	};
	for (const part of model.parts) {
		walk(part);
	}
	return out;
}

/** One version's jar, its mappings (or the identity), and the entity types its lang file registers. */
async function openVersion(version: string) {
	const jar = vanillaJar(version);
	const classes = new JarClassReader(jar);
	const names = await classes.list();
	const { mappings, obfuscated } = await resolveMappings(version, mappingCache, async () => names);
	// The same view of the jar the exporter builds, so these numbers are the ones a pack ships
	const code = await loadModelCode(
		names,
		async internal => await classes.read(internal),
		internal => mappings.originalOf.get(internal) ?? internal,
	);
	const geometry = new Map<string, ExtractedModel | null>();
	const geometryOf = async (name: string): Promise<ExtractedModel | null> => {
		if (!geometry.has(name)) {
			geometry.set(name, await extractInheritedModel(name, async internal => await classes.read(internal), code));
		}
		return geometry.get(name) ?? null;
	};
	const context = {
		mappings,
		read: classReader(async name => await classes.read(name)),
		hasGeometry: async (name: string) => {
			const model = await geometryOf(name);
			return model !== null && cubesOf(model) > 0;
		},
	};
	const resources = new JarResourceManager(jar);
	const raw = await resources.getResource('lang', new ResourceLocator('minecraft', 'en_us'));
	const lang = JSON.parse((raw ?? Buffer.from('{}')).toString('utf8')) as Record<string, string>;
	const types = Object.keys(lang)
		.filter(key => key.startsWith('entity.minecraft.') && key.split('.').length === 3)
		.map(key => key.slice('entity.minecraft.'.length));
	return { classes, context, geometryOf, types, obfuscated };
}

describe('mergeModels', () => {
	const part = (name: string, size: number): Part => {
		return {
			name,
			pivot: [0, 0, 0],
			rotation: [0, 0, 0],
			cubes: [{ origin: [0, 0, 0], size: [size, size, size], uv: [0, 0], inflate: 0, mirror: false }],
			children: [],
		};
	};
	const model = (parts: Part[], textureSize: [number, number] = [64, 32]): ExtractedModel => {
		return { textureSize, parts, notes: [] };
	};

	/** What the calls could not reach, one class at a time: a name the subclass never mentions. */
	it('takes the parts the base does not name, and never replaces one it does', () => {
		const merged = mergeModels(
			model([part('head', 8)]),
			model([part('head', 6), part('body', 10)]),
		);

		expect(merged.parts.map(entry => entry.name)).toStrictEqual(['head', 'body']);
		// The base's head, because it is the more derived of the two
		expect(merged.parts[0].cubes[0].size).toStrictEqual([8, 8, 8]);
	});

	/** A 1.17+ mesh has one anonymous root, so its parts are a level down and have to merge there. */
	it('merges into the anonymous root a mesh builds, rather than beside it', () => {
		const container = (children: Part[]): Part => {
			return { name: 'part1', pivot: [0, 0, 0], rotation: [0, 0, 0], cubes: [], children };
		};
		const merged = mergeModels(
			model([container([part('head', 8)])]),
			model([container([part('head', 6), part('body', 10)])]),
		);

		expect(merged.parts).toHaveLength(1);
		expect(merged.parts[0].children.map(entry => entry.name)).toStrictEqual(['head', 'body']);
	});

	/** A subclass that never states its own sheet takes its ancestor's rather than the default. */
	it('inherits a stated sheet size over the default', () => {
		expect(mergeModels(model([part('head', 8)]), model([part('body', 10)], [128, 128])).textureSize)
			.toStrictEqual([128, 128]);
		expect(mergeModels(model([part('head', 8)], [64, 64]), model([part('body', 10)], [128, 128])).textureSize)
			.toStrictEqual([64, 64]);
	});
});

describe('parseMappings', () => {
	it('reads class lines and ignores members', () => {
		const mappings = parseMappings([
			'# compiled from a comment',
			'net.minecraft.client.model.CowModel -> fvd:',
			'    12:34:void <init>(x) -> a',
			'net.minecraft.world.entity.EntityType -> cgn:',
		].join('\n'));

		expect(mappings.obfuscatedOf.get('net.minecraft.client.model.CowModel')).toBe('fvd');
		expect(mappings.originalOf.get('fvd')).toBe('net.minecraft.client.model.CowModel');
		expect(mappings.obfuscatedOf.size).toBe(2);
	});
});

describe('identityMappings', () => {
	/** From the 26 line Mojang stopped obfuscating, so the jar's own names are the real ones. */
	it('maps a deobfuscated jar to itself, with dots', () => {
		const mappings = identityMappings(['net/minecraft/client/model/animal/cow/CowModel']);

		expect(mappings.obfuscatedOf.get('net.minecraft.client.model.animal.cow.CowModel'))
			.toBe('net.minecraft.client.model.animal.cow.CowModel');
	});
});

describe('isObfuscated', () => {
	/**
	 * The jar decides whether a mapping is needed, not the manifest — otherwise a current version costs
	 * two HTTP requests per export to learn what the archive already states, and cannot be exported
	 * offline at all.
	 */
	it('reads it off the class paths', () => {
		expect(isObfuscated(['net/minecraft/client/model/CowModel', 'com/mojang/blaze3d/Blaze3D'])).toBe(false);
		// An obfuscated jar keeps its entrypoint in the clear, so that alone must not read as unobfuscated
		expect(isObfuscated(['fvd', 'gke$a', 'net/minecraft/client/main/Main'])).toBe(true);
	});

	it('needs no mappings for a real 26.x jar', async () => {
		const classes = new JarClassReader(vanillaJar('26.2'));
		try {
			expect(isObfuscated(await classes.list())).toBe(false);
		} finally {
			await classes.close();
		}
	});

	it('needs them for a real 1.21.1 jar', async () => {
		const classes = new JarClassReader(vanillaJar('1.21.1'));
		try {
			expect(isObfuscated(await classes.list())).toBe(true);
		} finally {
			await classes.close();
		}
	});
});

describe('the class reader', () => {
	it('reads a constant pool and the methods of a real class', async () => {
		const classes = new JarClassReader(vanillaJar('26.2'));
		const bytes = await classes.read('net/minecraft/client/model/animal/cow/CowModel');
		expect(bytes).not.toBeNull();

		const parsed = parseClassFile(bytes as Uint8Array);
		expect(parsed.thisClass).toBe('net/minecraft/client/model/animal/cow/CowModel');
		expect(parsed.constants.length).toBeGreaterThan(20);
		// Something has to carry code, or there is nothing to interpret
		expect(parsed.methods.some(method => method.code !== undefined)).toBe(true);
		await classes.close();
	});
});

describe('the cow, from an obfuscated jar', () => {
	/**
	 * Vanilla's cow body: `addBox(-6, -10, -7, 12, 18, 10)` at `texOffs(18, 4)` on a 64x32 sheet. Those
	 * six numbers are the difference between a cow and a differently-shaped animal, and they come out of
	 * a class called `fvd`.
	 */
	it('recovers the exact body box, through the mapping', { timeout: 120000 }, async () => {
		const { classes, context, geometryOf, types } = await openVersion('1.21.1');
		try {
			expect(types).toContain('cow');
			const link = await linkEntityModel('cow', context);
			expect(link?.className).toBe('net.minecraft.client.model.CowModel');
			// The point of the exercise: the class it reads is not called anything like "cow"
			expect(link?.obfuscated).not.toContain('ow');

			const model = await geometryOf((link as { obfuscated: string; }).obfuscated);
			expect(model?.textureSize).toStrictEqual([64, 32]);
			const body = allCubes(model as ExtractedModel).find(entry => entry.part === 'body');
			expect(body?.cube.origin).toStrictEqual([-6, -10, -7]);
			expect(body?.cube.size).toStrictEqual([12, 18, 10]);
			expect(body?.cube.uv).toStrictEqual([18, 4]);
			// And the hierarchy is a quadruped's
			const bones = (model as ExtractedModel).parts.flatMap(part => bonesOf(part));
			expect(bones).toEqual(expect.arrayContaining([
				'body', 'head', 'right_hind_leg', 'left_hind_leg', 'right_front_leg', 'left_front_leg',
			]));
			/*
			 * The head, on its neck, with its horns. This is the regression guard for the named-box overload
			 * `addBox(String, x, y, z, w, h, d)`, which a cow's horns use: rejecting it broke the fluent
			 * chain, and the whole head fell out of the tree unnamed, at the origin, with no pose.
			 */
			const head = (model as ExtractedModel).parts.flatMap(part => part.children)
				.find(part => part.name === 'head');
			expect(head?.pivot).toStrictEqual([0, 4, -8]);
			// The head box plus the two named horn boxes
			expect(head?.cubes).toHaveLength(3);
			expect(head?.cubes[0].origin).toStrictEqual([-4, -4, -6]);
			expect(head?.cubes[0].size).toStrictEqual([8, 8, 6]);
			// One connected tree, so nothing to warn about
			expect((model as ExtractedModel).parts).toHaveLength(1);
			expect((model as ExtractedModel).notes).toStrictEqual([]);
		} finally {
			await classes.close();
		}
	});

	/** The same cow out of a jar that was never obfuscated, to prove the identity path agrees. */
	it('recovers the same box from a deobfuscated jar', { timeout: 120000 }, async () => {
		const { classes, context, geometryOf, obfuscated } = await openVersion('26.2');
		try {
			expect(obfuscated).toBe(false);
			const link = await linkEntityModel('cow', context);
			expect(link?.className).toContain('CowModel');

			const model = await geometryOf((link as { obfuscated: string; }).obfuscated);
			const body = allCubes(model as ExtractedModel).find(entry => entry.part === 'body');
			expect(body?.cube.origin).toStrictEqual([-6, -10, -7]);
			expect(body?.cube.size).toStrictEqual([12, 18, 10]);
		} finally {
			await classes.close();
		}
	});
});

describe('shared and inherited models', () => {
	/**
	 * The two shapes that cost the most coverage when they were missed. A cave spider hands a layer to
	 * `SpiderRenderer`, so its own class names no model at all; a zombie's `ZombieModel` is an empty
	 * shell over `HumanoidModel`, two hops up, which is where the boxes actually are.
	 */
	it('follows a renderer chain and a model chain', { timeout: 120000 }, async () => {
		const { classes, context, geometryOf } = await openVersion('1.21.1');
		try {
			const spider = await linkEntityModel('cave_spider', context);
			expect(spider?.className).toContain('SpiderModel');

			/*
			 * `ZombieModel` is an empty shell two hops above `HumanoidModel`, which is where the boxes are.
			 * The zombie is credited to its own class because that is what the game draws it with, and the
			 * shape it carries is the humanoid one it inherits.
			 */
			const zombie = await linkEntityModel('zombie', context);
			expect(zombie?.className).toContain('ZombieModel');
			const model = await geometryOf((zombie as { obfuscated: string; }).obfuscated);
			expect((model as ExtractedModel).parts.flatMap(part => bonesOf(part))).toEqual(
				expect.arrayContaining(['head', 'body', 'left_arm', 'right_arm', 'left_leg', 'right_leg']),
			);
		} finally {
			await classes.close();
		}
	});

	/** 1.21.2 split boats into one type per wood, all still drawn by the one model. */
	it('links every wood of boat to the boat model', { timeout: 120000 }, async () => {
		const { classes, context, types } = await openVersion('1.21.8');
		try {
			const boats = types.filter(type => type.endsWith('_boat'));
			expect(boats.length).toBeGreaterThan(8);
			for (const boat of boats) {
				const link = await linkEntityModel(boat, context);
				expect(link?.className, boat).toContain('BoatModel');
			}
		} finally {
			await classes.close();
		}
	});
});

describe('parts built by another class', () => {
	/**
	 * The pre-1.17 shape, and the one that was wrong the longest. A 1.16.5 cow declares a head with
	 * horns and a body, calls `super(12, 0)`, and inherits four legs whose height is that 12. Reading
	 * `CowModel` alone gives a two-part cow; reading it without the argument gives four legs of height
	 * zero, which is a cow standing on nothing and looks exactly like a bug in the mesher.
	 */
	it('inherits the legs of a 1.16.5 cow, at the height its constructor asked for', { timeout: 120000 }, async () => {
		const { classes, context, geometryOf } = await openVersion('1.16.5');
		try {
			const link = await linkEntityModel('cow', context);
			const model = await geometryOf((link as { obfuscated: string; }).obfuscated);
			const cubes = allCubes(model as ExtractedModel);
			// Head with two horns, body with an udder, and the four legs from QuadrupedModel
			expect((model as ExtractedModel).parts).toHaveLength(6);
			expect(cubes.filter(entry => entry.cube.size.join(',') === [4, 12, 4].join(','))).toHaveLength(4);
			/*
			 * And their texture offsets, which that era states nowhere but in `new ModelRenderer(this, 18,
			 * 4)`: every box came out addressed at the top left of the sheet until those two ints were read.
			 */
			const body = cubes.find(entry => entry.cube.size.join(',') === [12, 18, 10].join(','));
			expect(body?.cube.uv).toStrictEqual([18, 4]);
			expect(cubes.filter(entry => entry.cube.size.join(',') === [4, 12, 4].join(','))
				.every(entry => entry.cube.uv.join(',') === [0, 16].join(','))).toBe(true);
		} finally {
			await classes.close();
		}
	});

	/**
	 * Before 1.17 a part takes two `(int, int)` calls: its texture offset and `setTexSize`, the sheet
	 * that offset is in. An obfuscated jar renames both to `a`, so telling them apart is guesswork with
	 * one rule — the offset came from the constructor, so a pair shaped like a sheet is the other call.
	 * Get it wrong and every box after it is addressed at 64,32.
	 */
	it('keeps a 1.16.5 skeleton offset apart from its sheet size', { timeout: 120000 }, async () => {
		const { classes, context, geometryOf } = await openVersion('1.16.5');
		try {
			const link = await linkEntityModel('skeleton', context);
			const model = await geometryOf((link as { obfuscated: string; }).obfuscated);
			const offsets = allCubes(model as ExtractedModel).map(entry => entry.cube.uv.join(','));
			// Head 0,0 and hat 32,0 on the same box size; body 16,16; the skeleton's thin arms 40,16
			expect(offsets).toContain([32, 0].join(','));
			expect(offsets).toContain([16, 16].join(','));
			expect(offsets).toContain([40, 16].join(','));
			expect((model as ExtractedModel).textureSize).toStrictEqual([64, 32]);
		} finally {
			await classes.close();
		}
	});

	/** 26.2's pig starts from `QuadrupedModel.createBodyMesh(6, …)` and replaces only the head. */
	it('fills in the body a modern pig inherits, and replaces the head once', { timeout: 120000 }, async () => {
		const { classes, context, geometryOf } = await openVersion('26.2');
		try {
			const link = await linkEntityModel('pig', context);
			const model = await geometryOf((link as { obfuscated: string; }).obfuscated);
			const cubes = allCubes(model as ExtractedModel);
			// The head is the pig's own, with its snout, and there is only one of them
			expect(cubes.filter(entry => entry.part === 'head')).toHaveLength(2);
			// The body and the four legs come from the ancestor, at the size it was passed
			expect(cubes.some(entry => entry.part === 'body')).toBe(true);
			expect(cubes.filter(entry => entry.part.endsWith('_leg'))).toHaveLength(4);
			expect(cubes.filter(entry => entry.part.endsWith('_leg'))
				.every(entry => entry.cube.size[1] > 0)).toBe(true);
		} finally {
			await classes.close();
		}
	});

	/**
	 * A witch is a villager with a hat on, and `VillagerModel` is neither her superclass nor named
	 * anything like her: she calls it sideways and then reaches into the mesh with `getChild("head")`.
	 * Both have to work or the hat, which is four nested parts, hangs off nothing.
	 */
	it('hangs the witch hat off the villager head she borrows', { timeout: 120000 }, async () => {
		const { classes, context, geometryOf } = await openVersion('1.21.1');
		try {
			const link = await linkEntityModel('witch', context);
			const model = await geometryOf((link as { obfuscated: string; }).obfuscated);
			const head = (model as ExtractedModel).parts
				.flatMap(part => [part, ...part.children])
				.find(part => part.name === 'head');
			expect(head?.children.map(child => child.name)).toContain('hat');
			// The villager body underneath, so this is the whole witch and not just her hat
			expect((model as ExtractedModel).parts.flatMap(part => bonesOf(part))).toContain('body');
			expect((model as ExtractedModel).notes).toStrictEqual([]);
		} finally {
			await classes.close();
		}
	});

	/**
	 * A renderer constructs the models it draws, so following those calls made renderers look like they
	 * held geometry — and a pufferfish renderer, which builds all three sizes, came out as one model
	 * with three sets of spines. Model code may call model code; a renderer may not.
	 */
	it('does not mistake a renderer for the models it builds', { timeout: 120000 }, async () => {
		const { classes, context } = await openVersion('1.14.4');
		try {
			const link = await linkEntityModel('pufferfish', context);
			expect(link?.className).toContain('Model');
			expect(link?.className).not.toContain('Renderer');
		} finally {
			await classes.close();
		}
	});
});

describe('a lambda', () => {
	/**
	 * A `MeshTransformer` is a lambda, and from 1.21.4 the donkey's chest is added inside one:
	 * `LayerDefinition.apply(mesh -> modifyMesh(mesh.getRoot()))`. Consuming the lambda rather than
	 * following it left the donkey in pieces — four parts with no parent, at the model origin — and it
	 * was the last vanilla model in that state.
	 *
	 * Following it means two hops through the class file: the `invokedynamic` names a row of
	 * `BootstrapMethods`, and that row's method handle names the body.
	 */
	it('follows a mesh transformer to the chest it adds', { timeout: 120000 }, async () => {
		const { classes, context, geometryOf } = await openVersion('1.21.4');
		try {
			const link = await linkEntityModel('donkey', context);
			const model = await geometryOf((link as { obfuscated: string; }).obfuscated);

			// One connected tree, and the chest boxes are in it
			expect((model as ExtractedModel).parts).toHaveLength(1);
			expect((model as ExtractedModel).notes).toStrictEqual([]);
			const bones = (model as ExtractedModel).parts.flatMap(part => bonesOf(part));
			expect(bones).toEqual(expect.arrayContaining(['left_chest', 'right_chest']));
			expect(cubesOf(model as ExtractedModel)).toBeGreaterThan(20);
		} finally {
			await classes.close();
		}
	});
});

describe('a mod entity drawn with a vanilla model', () => {
	/**
	 * Plenty are, and none of them ship geometry because none of them need to: Ars Nouveau's
	 * `summon_horse` is the game's own horse, its `ally_vex` a vex, and a mod adding a spawner for one
	 * calls it `iron_golem_spawner`. The decoration comes off a token at a time, longest match first.
	 */
	it('finds the vanilla model under a mod id', { timeout: 120000 }, async () => {
		const { classes, context } = await openVersion('1.21.1');
		try {
			const horse = await linkEntityModel('ars_nouveau:summon_horse', context);
			expect(horse?.className).toContain('HorseModel');
			expect(horse?.route).toBe('vanilla-name');

			expect((await linkEntityModel('ars_nouveau:ally_vex', context))?.className).toContain('VexModel');
			// Longest first, so this is the iron golem rather than anything merely named `iron`
			expect((await linkEntityModel('somemod:iron_golem_spawner', context))?.className)
				.toContain('IronGolemModel');
		} finally {
			await classes.close();
		}
	});

	/** And nothing is borrowed for an id that names no mob, however many tokens come off it. */
	it('borrows nothing for an id that is not a mob', { timeout: 120000 }, async () => {
		const { classes, context } = await openVersion('1.21.1');
		try {
			expect(await linkEntityModel('ars_nouveau:spell_proj', context)).toBeNull();
			expect(await linkEntityModel('ars_nouveau:scryer_camera', context)).toBeNull();
			// A vanilla id is never decorated, so the route never runs for one
			expect(await linkEntityModel('minecraft:enchanted_falling_block', context)).toBeNull();
		} finally {
			await classes.close();
		}
	});
});

describe('layeredClasses', () => {
	/**
	 * A modded export layers the mods' classes over the client's. Before that the class source was the
	 * client jar alone, so a mod's own model classes were never read at all and its mobs came out as
	 * boxes however good the interpreter was.
	 */
	it('reads through the layers, first match winning', async () => {
		const source = (entries: Record<string, string>) => {
			return {
				list: async () => Object.keys(entries),
				read: async (name: string) => entries[name] ? new TextEncoder().encode(entries[name]) : null,
				close: async () => undefined,
			};
		};
		const layered = layeredClasses([source({ shared: 'mod', only: 'mod' }), source({ shared: 'vanilla', other: 'vanilla' })]);

		expect((await layered.list()).toSorted()).toStrictEqual(['only', 'other', 'shared']);
		expect(new TextDecoder().decode(await layered.read('shared') as Uint8Array)).toBe('mod');
		expect(new TextDecoder().decode(await layered.read('other') as Uint8Array)).toBe('vanilla');
		expect(await layered.read('absent')).toBeNull();
	});
});

describe('the dragon', () => {
	/**
	 * Held out for a long time: it failed first on an unhandled `daload`, then on a builder loop, and
	 * only came out whole once the named-box overload was handled. Worth its own test because it is the
	 * largest model in the game and exercised three separate gaps on its way in.
	 */
	it('comes out whole, with every bone named', { timeout: 120000 }, async () => {
		const { classes, context, geometryOf } = await openVersion('1.21.1');
		try {
			const link = await linkEntityModel('ender_dragon', context);
			expect(link).not.toBeNull();
			const model = await geometryOf((link as { obfuscated: string; }).obfuscated);
			expect(cubesOf(model as ExtractedModel)).toBeGreaterThan(30);
			const bones = (model as ExtractedModel).parts.flatMap(part => bonesOf(part));
			expect(bones).toEqual(expect.arrayContaining(['head', 'neck', 'body', 'left_wing', 'right_wing']));
		} finally {
			await classes.close();
		}
	});
});

describe('what it refuses', () => {
	it('refuses a version with no mappings and an obfuscated jar', async () => {
		await expect(resolveMappings('1.13.2', mappingCache, async () => ['aa', 'ab']))
			.rejects.toThrow(/needs 1\.14\.4 or newer/);
	});
});

/**
 * Per-version floors. The whole point of the extractor is breadth, so the guarantee worth keeping is
 * "this many mobs still come out" rather than any single one of them.
 *
 * `linked` counts entity types that resolved to real geometry; `cubes` guards against a regression
 * that keeps the links but empties the shapes, which a count of links alone would not notice.
 */
const COVERAGE = [
	{ version: '1.14.4', linked: 82, cubes: 719 },
	{ version: '1.16.5', linked: 88, cubes: 798 },
	{ version: '1.18.2', linked: 91, cubes: 814 },
	{ version: '1.19.4', linked: 98, cubes: 898 },
	{ version: '1.21.1', linked: 102, cubes: 939 },
	{ version: '1.21.4', linked: 125, cubes: 1171 },
	{ version: '1.21.8', linked: 126, cubes: 1148 },
	{ version: '1.21.11', linked: 132, cubes: 1223 },
	{ version: '26.2', linked: 133, cubes: 1256 },
];

describe.each(COVERAGE)('coverage for $version', (testCase) => {
	it('extracts geometry for the mobs it should, and accounts for the rest', { timeout: 300000 }, async () => {
		const { classes, context, geometryOf, types } = await openVersion(testCase.version);
		try {
			let linked = 0;
			let cubes = 0;
			const unaccounted: string[] = [];
			for (const type of types) {
				const link = await linkEntityModel(type, context);
				if (!link) {
					if (!NO_MODEL.has(type)) {
						unaccounted.push(type);
					}
					continue;
				}
				linked++;
				const model = await geometryOf(link.obfuscated);
				cubes += model ? cubesOf(model) : 0;
			}

			expect(linked).toBeGreaterThanOrEqual(testCase.linked);
			expect(cubes).toBeGreaterThanOrEqual(testCase.cubes);
			/*
			 * Anything neither linked nor listed is a mob the pack silently has no shape for, which is the
			 * failure this whole file exists to catch. Every version currently accounts for all of them, so
			 * this is exact rather than an allowance — a new mob that links to nothing fails the build.
			 */
			expect(unaccounted).toStrictEqual([]);
		} finally {
			await classes.close();
		}
	});
});
