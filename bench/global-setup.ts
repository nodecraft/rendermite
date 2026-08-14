/**
 * Benchmarks stage only the fixtures they measure — one vanilla jar and the
 * synthetic mod jars — rather than the whole test corpus, so `npm run bench` on
 * a fresh checkout is a short download instead of every supported version.
 */

import { ensureVanillaJar } from '../test/fixtures/index.ts';
import { buildFixtureModJars } from '../test/fixtures/mods.ts';

export const BENCH_VERSION = '1.21.8';

export default async function setup(): Promise<void> {
	await Promise.all([
		buildFixtureModJars(),
		ensureVanillaJar(BENCH_VERSION),
	]);
}
