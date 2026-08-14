import { defineConfig } from 'vitest/config';

/**
 * Benchmarks live apart from the test suite: they stage one fixture version
 * instead of all of them, and they must run in a single process so timings are
 * not measured against whatever else a worker pool happens to be doing.
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
		},
	},
});
