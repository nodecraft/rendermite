import { availableParallelism } from 'node:os';

import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/**/*.test.ts'],
		globalSetup: ['test/global-setup.ts'],
		/*
		 * Vitest defaults to `cpus - 1` workers, which is 1 on a two-core CI runner:
		 * the suite is render-bound, so that leaves half the machine idle for the
		 * whole run. Use every core instead.
		 */
		maxWorkers: availableParallelism(),
	},
});
