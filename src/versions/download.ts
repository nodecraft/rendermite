/**
 * Client jar acquisition: resolves versions through mcversions.net's index
 * (stable + snapshot channels) and downloads from Mojang, caching by version.
 * Shared by the CLI's --version flag and the test fixtures.
 */

import { existsSync } from 'node:fs';
import {
	mkdir,
	readFile,
	rename,
	writeFile,
} from 'node:fs/promises';
import path from 'node:path';

interface VersionIndex {
	stable: Record<string, { client: string; }>;
	snapshot: Record<string, { client: string; }>;
}

export async function downloadClientJar(version: string, cacheDir: string): Promise<string> {
	const jarPath = path.join(cacheDir, `${version}-client.jar`);
	if (existsSync(jarPath)) {
		return jarPath;
	}
	await mkdir(cacheDir, { recursive: true });

	const indexPath = path.join(cacheDir, 'mcversions.json');
	let index: VersionIndex;
	if (existsSync(indexPath)) {
		index = JSON.parse(await readFile(indexPath, 'utf8')) as VersionIndex;
	} else {
		const response = await fetch('https://mcversions.net/mcversions.json');
		if (!response.ok) {
			throw new Error(`mcversions.net index fetch failed: ${response.status}`);
		}
		const body = Buffer.from(await response.arrayBuffer());
		await writeFile(indexPath, body);
		index = JSON.parse(body.toString('utf8')) as VersionIndex;
	}

	const entry = index.stable[version] ?? index.snapshot[version];
	if (!entry) {
		throw new Error(`Version ${version} not found in the mcversions index`);
	}
	const download = await fetch(entry.client);
	if (!download.ok) {
		throw new Error(`Client jar download failed for ${version}: ${download.status}`);
	}
	// Temp name so an interrupted download never looks cached.
	const partial = `${jarPath}.partial`;
	await writeFile(partial, Buffer.from(await download.arrayBuffer()));
	await rename(partial, jarPath);
	return jarPath;
}
