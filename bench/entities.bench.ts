/**
 * Entity geometry extraction, measured.
 *
 * Worth benchmarking because it runs once per pack and there are 546 packs in a full seed: a second per
 * version is a nine-minute tax on the seed, and a second per *mod* is two hours. The three phases cost
 * very different amounts and only one of them is obviously expensive, so they are measured apart.
 *
 * Setup is top-level because Vitest does not run suite hooks in benchmark mode.
 */

import { bench, describe } from 'vitest';

import { BENCH_VERSION } from './global-setup.ts';
import {
	JarClassReader,
	buildModelNameIndex,
	classReader,
	extractInheritedModel,
	extractModel,
	identityMappings,
	isObfuscated,
	linkEntityModel,
	loadMappings,
	loadModelCode,
	parseClassFile,
} from './subject.ts';
import { fixturesDir, vanillaJar } from '../test/fixtures/index.ts';

import type { ExtractedModel, Part } from './subject.ts';

const jar = vanillaJar(BENCH_VERSION);
const classes = new JarClassReader(jar);
const names = await classes.list();
const mappings = isObfuscated(names)
	? await loadMappings(BENCH_VERSION, fixturesDir)
	: identityMappings(names);

/** The cow, which is the model every other measurement here is a multiple of. */
const cowClass = mappings.obfuscatedOf.keys()
	.filter(name => name.endsWith('.CowModel'))
	.toArray()[0];
const cowBytes = await classes.read(mappings.obfuscatedOf.get(cowClass) as string) as Uint8Array;

function countCubes(part: Part): number {
	return part.cubes.length + part.children.reduce((sum, child) => sum + countCubes(child), 0);
}
const cubesOf = (model: ExtractedModel): number => model.parts.reduce((sum, part) => sum + countCubes(part), 0);

/**
 * Every model class, pre-read so the loop below measures interpretation and not I/O.
 *
 * Found through the mappings rather than by looking for "model" in the class name: on an obfuscated jar
 * the classes are called `fvd`, and a name filter finds none of them — which is how the first version of
 * this benchmark came to measure an empty loop and report itself sixteen thousand times faster than the
 * thing beside it.
 */
const modelBytes: Uint8Array[] = [];
for (const className of mappings.obfuscatedOf.keys()) {
	if (!className.endsWith('Model') || !className.includes('.client.model')) {
		continue;
	}
	const bytes = await classes.read(mappings.obfuscatedOf.get(className) as string);
	if (!bytes) {
		continue;
	}
	try {
		if (cubesOf(extractModel(bytes)) > 0) {
			modelBytes.push(bytes);
		}
	} catch {
		continue;
	}
}

/** The jar's model code, read as the exporter reads it: once, before any interpretation. */
const code = await loadModelCode(names, async name => await classes.read(name), name => mappings.originalOf.get(name) ?? name);

describe('reading one class', () => {
	bench('parse the constant pool and methods', () => {
		parseClassFile(cowBytes);
	});

	bench('parse and interpret, one model', () => {
		extractModel(cowBytes);
	});
});

describe('a whole jar', () => {
	/*
	 * The number that matters for a seed: every model in the jar, interpreted, with the bytes already in
	 * hand. If this is slow the seed is slow, and no amount of caching elsewhere helps.
	 */
	bench(`interpret every model in ${BENCH_VERSION} (${modelBytes.length} classes)`, () => {
		for (const bytes of modelBytes) {
			extractModel(bytes);
		}
	});

	/*
	 * Building the fuzzy-match index over every class name. Cheap, but it runs per jar and a mod pack has
	 * three hundred of them, so a linear scan that turned quadratic would show up here first.
	 */
	bench(`index ${names.length} class names for the mod route`, () => {
		buildModelNameIndex(names);
	});
});

describe('following calls', () => {
	/*
	 * What the exporter actually runs, and the reason this is measured apart: a model is read together
	 * with its ancestors and the calls into them are interpreted with their arguments, so one entity
	 * costs several classes rather than one. `loadModelCode` reads every model class in the jar up front
	 * — interpretation is synchronous, so a call's target has to already be in hand — and that up-front
	 * read is the part that would hurt a 546-pack seed if it were slow.
	 */
	bench(`read every model class in ${BENCH_VERSION} up front`, async () => {
		await loadModelCode(names, async name => await classes.read(name), name => mappings.originalOf.get(name) ?? name);
	});

	bench('extract one model with its ancestors and its calls followed', async () => {
		await extractInheritedModel(mappings.obfuscatedOf.get(cowClass) as string, async name => await classes.read(name), code);
	});
});

describe('linking', () => {
	const context = {
		mappings,
		read: classReader(async name => await classes.read(name)),
		hasGeometry: async (name: string): Promise<boolean> => {
			const bytes = await classes.read(name);
			return bytes !== null && cubesOf(extractModel(bytes)) > 0;
		},
		nameIndex: buildModelNameIndex(names),
	};

	/*
	 * A cold link walks renderer and model superclass chains and re-reads classes as it goes, so it is
	 * the phase most likely to surprise. `classReader` caches, which is exactly what this measures the
	 * value of.
	 */
	bench('link one entity to its model class', async () => {
		await linkEntityModel('cow', context);
	});

	bench('link a shared model through two chains (cave_spider)', async () => {
		await linkEntityModel('cave_spider', context);
	});
});
