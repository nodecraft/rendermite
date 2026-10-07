import { defineConfig } from 'vitest/config';

/**
 * Benchmarks live apart from the test suite: they stage one fixture version
 * instead of all of them, and they must run in a single process so timings are
 * not measured against whatever else a worker pool happens to be doing.
 *
 * `node --run bench:against` adds a second source tree to that process rather than
 * a second run; see `bench/sides.ts`.
 */
export default defineConfig({
	test: {
		globalSetup: ['bench/global-setup.ts'],
		// One process, one thread: a timing measured against a busy worker pool is
		// noise, not a benchmark.
		pool: 'threads',
		maxWorkers: 1,
		fileParallelism: false,
		benchmark: {
			include: ['bench/**/*.bench.ts'],
			// `.bench/base` is a worktree of the ref being compared against, and it
			// holds that commit's copy of this directory. Collecting it would run
			// the suite twice over, with the two copies competing for one CPU.
			exclude: ['**/.bench/**', '**/node_modules/**'],
		},
	},
});
