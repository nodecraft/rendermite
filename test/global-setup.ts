/**
 * Vitest global setup: stage every fixture the suites need. Vanilla jars come
 * from Mojang at runtime (cached in .work/fixtures/), synthetic mod jars are
 * built from the committed declarations. Nothing references a developer
 * machine; a fresh checkout only needs network access on the first run.
 */

import { ensureVanillaJar, fixturesDir } from './fixtures/index.ts';
import { buildFixtureModJars } from './fixtures/mods.ts';
import { MappingsUnavailableError, downloadClientMappings } from '../src/entities/mappings.ts';

/** Every version the suites exercise, donors and the pre-1.6 reference included. */
const VERSIONS = [
	'26.4-snapshot-4',
	'26.3',
	'26.2',
	'26.1.2',
	'1.21.11',
	'1.21.8',
	'1.21.4',
	'1.21.1',
	'1.20.4',
	'1.19.4',
	'1.18.2',
	'1.17.1',
	'1.16.5',
	'1.15.2',
	'1.14.4',
	'1.13.2',
	'1.12.2',
	'1.11.2',
	'1.10.2',
	'1.9.4',
	'1.8.9',
	'1.7.10',
	'1.6.4',
	'1.5.2',
	'1.4.7',
	'1.2.5',
];

/**
 * Mappings, or the record that a version has none, staged here so they land in CI's fixture cache
 * instead of being fetched mid-suite where one dropped connection fails a test.
 */
async function stageMappings(version: string): Promise<void> {
	try {
		await downloadClientMappings(version, fixturesDir);
	} catch (err) {
		if (!(err instanceof MappingsUnavailableError)) {
			throw err;
		}
	}
}

export default async function setup(): Promise<void> {
	await Promise.all([
		buildFixtureModJars(),
		...VERSIONS.map(version => ensureVanillaJar(version)),
		...VERSIONS.map(version => stageMappings(version)),
	]);
}
