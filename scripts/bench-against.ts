/**
 * Benches this working tree against another ref and writes the pull request comment.
 *
 *   node --run bench:against                    # vs origin/main
 *   node --run bench:against -- --base HEAD~1
 *   node --run bench:against -- --base HEAD     # what this machine's own floor is today
 *   node --run bench:against -- --filter render
 *
 * The base ref is checked out into `.bench/base` and given **this** tree's
 * `bench/subject.ts`, which is the whole surface the benchmarks use to reach it.
 * Fixtures, harness and inputs all come from this tree, so only `src/` differs:
 * a pull request touching the benchmarks would otherwise measure the two sides
 * with two different rulers.
 *
 * A single Vitest run then registers every workload twice, base and head,
 * adjacent in one process. See `bench/sides.ts` for why two runs cannot.
 */

import { spawnSync } from 'node:child_process';
import {
	cpSync,
	existsSync,
	mkdirSync,
	rmSync,
} from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		base: { type: 'string', default: '' },
		filter: { type: 'string' },
		out: { type: 'string', default: '.bench/comment.md' },
		keep: { type: 'boolean', default: false },
	},
});

const root = path.join(import.meta.dirname, '..');
const work = path.join(root, '.bench');
const baseTree = path.join(work, 'base');

function run(command: string, args: string[], options: { quiet?: boolean; env?: NodeJS.ProcessEnv; } = {}): string {
	const result = spawnSync(command, args, {
		cwd: root,
		env: options.env,
		encoding: 'utf8',
		// No shell: an argument like a `^(a|b)$` filter must not be re-parsed by cmd.exe
		stdio: ['ignore', 'pipe', options.quiet ? 'pipe' : 'inherit'],
	});
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr ?? ''}`);
	}
	return (result.stdout ?? '').trim();
}

/** `origin/main` where a remote is configured, else the local branch. */
function resolveBase(): string {
	if (values.base) {
		return values.base;
	}
	for (const candidate of ['origin/main', 'main']) {
		const found = spawnSync('git', ['rev-parse', '--verify', '--quiet', candidate], { cwd: root, encoding: 'utf8' });
		if (found.status === 0 && found.stdout.trim() !== '') {
			return candidate;
		}
	}
	throw new Error('Could not find origin/main or main; pass --base <ref>.');
}

const baseRef = resolveBase();
const baseSha = run('git', ['rev-parse', '--short', baseRef], { quiet: true });
const headSha = run('git', ['rev-parse', '--short', 'HEAD'], { quiet: true });
process.stderr.write(`base ${baseRef} (${baseSha})  ->  head (${headSha})\n\n`);

/*
 * A worktree left behind by an interrupted run would silently bench the wrong
 * commit, and one deleted by hand stays *registered*, which makes the next
 * `add` fail rather than recover. Both are cleared, in that order.
 */
if (existsSync(baseTree)) {
	spawnSync('git', ['worktree', 'remove', '--force', baseTree], { cwd: root });
	rmSync(baseTree, { recursive: true, force: true });
}
spawnSync('git', ['worktree', 'prune'], { cwd: root });
mkdirSync(work, { recursive: true });
run('git', ['worktree', 'add', '--detach', baseTree, baseRef], { quiet: true });

/*
 * `bench/subject.ts` and nothing else. Copying the `.bench.ts` files too would
 * have Vitest collect this suite twice over, and the two copies would compete
 * for the same CPU.
 *
 * The base tree needs no `node_modules` of its own, because the worktree lives inside
 * this repository, so Node walks up out of `.bench/base` and finds the one
 * already here. Deliberately not a symlink or a junction to it either: removing
 * the worktree afterwards follows one on Windows and deletes the real
 * directory's contents, which is a very unpleasant way to find out.
 */
mkdirSync(path.join(baseTree, 'bench'), { recursive: true });
cpSync(path.join(root, 'bench', 'subject.ts'), path.join(baseTree, 'bench', 'subject.ts'));

const report = path.join(work, 'bench.json');
const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');

process.stderr.write('\n=== benchmarking base and head together ===\n');
run(process.execPath, [
	vitest,
	'bench',
	'--run',
	'--config',
	path.join(root, 'vitest.bench.config.ts'),
	'--outputJson',
	report,
	...values.filter ? ['-t', values.filter] : [],
], {
	env: {
		...process.env,
		/*
		 * `--expose-gc` lets each case start from a collected heap; see `OPTIONS`
		 * in bench/sides.ts. The heap headroom is not optional either: a paired run
		 * holds two module graphs with two sets of jar indexes, model and texture
		 * caches, and the animated render allocates float buffers by the megabyte
		 * on top. Against Vitest's worker default that workload went bimodal,
		 * 81ms an iteration until the heap grew and 184ms after.
		 */
		NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --expose-gc --max-old-space-size=4096`.trim(),
		// The directory, not a file: bench/sides.ts appends the module it wants off it
		RENDERMITE_BENCH_BASE: path.join(baseTree, 'bench').replaceAll('\\', '/'),
	},
});

process.stderr.write('\n=== comparison ===\n');
run(process.execPath, [
	path.join(root, 'scripts/bench-comment.ts'),
	'--report',
	report,
	'--base-label',
	`${baseRef}@${baseSha}`,
	'--head-label',
	`HEAD@${headSha}`,
	'--out',
	path.join(root, values.out),
]);

if (!values.keep) {
	spawnSync('git', ['worktree', 'remove', '--force', baseTree], { cwd: root });
}
process.stderr.write(`\ncomment written to ${values.out}\n`);
