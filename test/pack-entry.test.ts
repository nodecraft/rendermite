/**
 * `@nodecraft/rendermite/pack` is the entry a *renderer* imports, and the whole
 * point of it is what it leaves out: the main entry reaches jars, rasterizes
 * with `sharp` and writes files, none of which can enter a browser bundle.
 *
 * So this bundles the entry the way a consumer's bundler would and asserts what
 * came along. A stray value import — `import { x }` where `import type { x }`
 * was meant, or one convenience re-export from the exporter — would otherwise
 * pull the toolchain in silently, and the failure lands on whoever ships it.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';

import type { BlockPackBlockState } from '../src/blocks/pack-format.ts';

const root = path.join(import.meta.dirname, '..');

/**
 * Modules the entry may reach at runtime; types are erased and do not count.
 * `locator.ts` is in the module but only `parseBlockState` uses it, so a bundler
 * drops it — allowed rather than required, since that is a detail of shaking.
 */
const ALLOWED = new Set([
	'src/pack.ts',
	'src/blocks/blockstate-eval.ts',
	'src/resources/locator.ts',
]);

/** Bigger than the graph needs, small enough that pulling anything real fails it. */
const SIZE_BUDGET = 32 * 1024;

async function bundlePackEntry(): Promise<{ code: string; modules: string[]; }> {
	const build = await rolldown({
		input: path.join(root, 'src/pack.ts'),
		platform: 'browser',
		// Nothing is external: a dependency that sneaks in has to show up in the
		// output rather than being quietly left for the consumer to install.
		external: [],
	});
	const { output } = await build.generate({ format: 'esm' });
	await build.close();
	const chunks = output.filter(part => part.type === 'chunk');
	const modules = chunks
		.flatMap(chunk => Object.keys(chunk.modules))
		.map(id => path.relative(root, id).replaceAll('\\', '/'))
		.filter(id => !id.startsWith('\0') && id.endsWith('.ts'));
	return { code: chunks.map(chunk => chunk.code).join('\n'), modules };
}

describe('the pack entry', () => {
	it('reaches only the evaluation and its locator', async () => {
		const { modules } = await bundlePackEntry();
		expect(modules.filter(id => !ALLOWED.has(id))).toStrictEqual([]);
		expect(modules).toContain('src/blocks/blockstate-eval.ts');
	});

	it('pulls in no dependency and no node builtin', async () => {
		const { code } = await bundlePackEntry();
		// Bare specifiers survive bundling as imports, so any left are real
		const bare = code.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"'.][^"']*)["']/g).map(match => match[1]).toArray();
		expect(bare).toStrictEqual([]);
		expect(code).not.toMatch(/require\(|node:|from ['"]sharp|from ['"]lightningcss|from ['"]yauzl/);
	});

	it('stays small enough to ship to a browser', async () => {
		const { code } = await bundlePackEntry();
		expect(code.length).toBeLessThan(SIZE_BUDGET);
	});

	it('is published: the export map names it and the build emits it', () => {
		const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
			exports: Record<string, { types: string; import: string; }>;
			files: string[];
		};
		const entry = manifest.exports['./pack'];
		expect(entry).toStrictEqual({ types: './dist/pack.d.ts', import: './dist/pack.js' });
		expect(manifest.files).toContain('dist');
		// Only meaningful after a build, and worth saying when the build has run
		for (const file of [entry.types, entry.import]) {
			const built = path.join(root, file);
			if (existsSync(path.join(root, 'dist'))) {
				expect(existsSync(built), `${file} is missing from a built dist`).toBe(true);
			}
		}
	});

	it('exports the evaluation a pack consumer needs, and nothing from the exporter', async () => {
		const entry = await import('../src/pack.ts');
		expect(Object.keys(entry).toSorted((left, right) => left.localeCompare(right))).toStrictEqual([
			'evaluateBlockState',
			'matchesCondition',
			'weightedVariantIndex',
		]);
	});
	/**
	 * The source bundle above proves the module graph, but a consumer loads `dist`,
	 * which the build splits into shared chunks. A chunk shared with the exporter
	 * would ship `sharp` behind a source graph that still looks clean, so the built
	 * artifact is walked too. CI builds before it tests; locally this needs a build.
	 */
	it.runIf(existsSync(path.join(root, 'dist/pack.js')))('ships a built entry that reaches nothing else', () => {
		const seen = new Set<string>();
		const bare: string[] = [];
		const walk = (file: string): void => {
			const resolved = path.normalize(file);
			if (seen.has(resolved)) {
				return;
			}
			seen.add(resolved);
			const code = readFileSync(resolved, 'utf8');
			for (const match of code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)) {
				if (match[1].startsWith('.')) {
					walk(path.join(path.dirname(resolved), match[1]));
				} else {
					bare.push(match[1]);
				}
			}
		};
		walk(path.join(root, 'dist/pack.js'));
		expect(bare).toStrictEqual([]);
		expect([...seen].reduce((total, file) => total + statSync(file).size, 0)).toBeLessThan(SIZE_BUDGET);
	});
	/**
	 * The whole point of the entry: a state read straight out of `blockstates.json`
	 * evaluates with no cast. The emit drops every rotation at its default, so a
	 * type stating them as required would force a consumer to lie about the file.
	 */
	it('evaluates a state in the shape the pack file writes', async () => {
		const { evaluateBlockState } = await import('../src/pack.ts');
		const state = {
			variants: [
				{ when: { facing: 'north' }, apply: [{ model: 'minecraft:block/chest' }] },
				{ when: { facing: 'east' }, apply: [{ model: 'minecraft:block/chest', y: 90 }] },
			],
		} satisfies BlockPackBlockState;
		expect(evaluateBlockState({ kind: 'variants', cases: state.variants }, { facing: 'east' }))
			.toStrictEqual([[{ model: 'minecraft:block/chest', y: 90 }]]);
	});
});
