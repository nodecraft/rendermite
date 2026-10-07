/**
 * Pre-1.6 texture recovery: 1.5.x jars keep individually-named textures at the
 * archive root under old names (`oreDiamond.png`); ≤1.4.7 has only stitched sheets (terrain.png,
 * gui/items.png) whose cell identity lived in hardcoded Java. Both are
 * recovered by pixel-matching against the 1.6.4 reference art (the version
 * whose names the donor block models reference), emitting the pre-1.13 plural
 * texture directories the donor geometry expects. A tile that matches nothing
 * within tolerance is dropped — a text label beats someone else's icon.
 */

import sharp from 'sharp';
import { open } from 'yauzl';

import { MapResourceManager } from '../resources/synthetic.ts';

import type { ResourceManager } from '../resources/manager.ts';
import type { Entry, ZipFile } from 'yauzl';

const MATCH_TOLERANCE = 40;
const TILE_SIZE = 16;
const SHEET_COLUMNS = 16;

interface RawTile {
	name: string;
	pixels: Uint8ClampedArray;
	png: Buffer;
}

/** Read arbitrary entries out of a zip (pre-1.6 jars have no assets/ prefix). */
async function readJarEntries(jarPath: string, wanted: (path: string) => boolean): Promise<Map<string, Buffer>> {
	return new Promise((resolve, reject) => {
		open(jarPath, { lazyEntries: true }, (err, zip: ZipFile) => {
			if (err) {
				reject(err);
				return;
			}
			const results = new Map<string, Buffer>();
			let pending = 0;
			let ended = false;
			const finish = () => {
				if (ended && pending === 0) {
					zip.close();
					resolve(results);
				}
			};
			zip.on('entry', (entry: Entry) => {
				if (!wanted(entry.fileName)) {
					zip.readEntry();
					return;
				}
				pending++;
				zip.openReadStream(entry, (streamErr, stream) => {
					if (streamErr) {
						reject(streamErr);
						return;
					}
					const chunks: Buffer[] = [];
					stream.on('data', (chunk) => {
						chunks.push(chunk as Buffer);
					});
					stream.on('end', () => {
						results.set(entry.fileName, Buffer.concat(chunks));
						pending--;
						finish();
						zip.readEntry();
					});
					stream.on('error', reject);
				});
			});
			zip.on('end', () => {
				ended = true;
				finish();
			});
			zip.on('error', reject);
			zip.readEntry();
		});
	});
}

/** First 16x16 frame of a reference texture (animated strips use frame 0). */
async function referenceTile(png: Buffer): Promise<Uint8ClampedArray | null> {
	try {
		const image = await sharp(png)
			.extract({ left: 0, top: 0, width: TILE_SIZE, height: TILE_SIZE })
			.ensureAlpha()
			.raw()
			.toBuffer();
		return new Uint8ClampedArray(image.buffer, image.byteOffset, image.length);
	} catch {
		// Not 16px wide (e.g. HD or oddly sized) — unusable as a match reference.
		return null;
	}
}

function isBlankTile(pixels: Uint8ClampedArray): boolean {
	for (let i = 3; i < pixels.length; i += 4) {
		if (pixels[i] > 8) {
			return false;
		}
	}
	return true;
}

/** Sum of squared per-channel deltas over RGBA, divided by pixel count. */
function pixelDistance(candidate: Uint8ClampedArray, reference: Uint8ClampedArray): number {
	if (candidate.length !== reference.length) {
		return Infinity;
	}
	let sum = 0;
	// eslint-disable-next-line unicorn/no-for-loop -- index math over two parallel arrays
	for (let i = 0; i < candidate.length; i++) {
		const delta = candidate[i] - reference[i];
		sum += delta * delta;
	}
	return sum / (candidate.length / 4);
}

async function loadReferences(referenceJar: string, directory: 'blocks' | 'items'): Promise<Map<string, Uint8ClampedArray>> {
	const prefix = `assets/minecraft/textures/${directory}/`;
	const entries = await readJarEntries(referenceJar, path => path.startsWith(prefix) && path.endsWith('.png'));
	const references = new Map<string, Uint8ClampedArray>();
	for (const [path, png] of entries) {
		const pixels = await referenceTile(png);
		if (pixels) {
			references.set(path.slice(prefix.length, -4), pixels);
		}
	}
	return references;
}

function matchTile(
	pixels: Uint8ClampedArray,
	references: Map<string, Uint8ClampedArray>,
	taken: Set<string>,
): string | null {
	let bestName: string | null = null;
	let bestDistance = Infinity;
	for (const [name, reference] of references) {
		const distance = pixelDistance(pixels, reference);
		if (distance >= bestDistance) {
			continue;
		}
		bestDistance = distance;
		bestName = name;
	}
	// First match wins: a second match means the reference merged or reused that art.
	if (bestName !== null && bestDistance <= MATCH_TOLERANCE && !taken.has(bestName)) {
		return bestName;
	}
	return null;
}

/** Slice a stitched sheet into 16-column grid tiles, nearest-resized to 16x16. */
async function sheetTiles(png: Buffer): Promise<RawTile[]> {
	const meta = await sharp(png).metadata();
	const size = Math.floor((meta.width ?? 0) / SHEET_COLUMNS);
	if (size === 0) {
		return [];
	}
	const rows = Math.floor((meta.height ?? 0) / size);
	const tiles: RawTile[] = [];
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < SHEET_COLUMNS; column++) {
			const tile = sharp(png)
				.extract({ left: column * size, top: row * size, width: size, height: size })
				.resize(TILE_SIZE, TILE_SIZE, { kernel: 'nearest' });
			const raw = await tile.clone().ensureAlpha().raw()
				.toBuffer();
			tiles.push({
				name: `${row}_${column}`,
				pixels: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length),
				png: await tile.png().toBuffer(),
			});
		}
	}
	return tiles;
}

async function fileTiles(entries: Map<string, Buffer>, prefix: string): Promise<RawTile[]> {
	const tiles: RawTile[] = [];
	for (const [path, png] of entries) {
		if (!path.startsWith(prefix) || !path.endsWith('.png')) {
			continue;
		}
		const pixels = await referenceTile(png);
		if (pixels) {
			tiles.push({ name: path.slice(prefix.length, -4), pixels, png });
		}
	}
	return tiles;
}

async function matchInto(
	output: MapResourceManager,
	tiles: RawTile[],
	references: Map<string, Uint8ClampedArray>,
	directory: 'blocks' | 'items',
): Promise<{ matched: number; dropped: number; }> {
	const taken = new Set<string>();
	let matched = 0;
	let dropped = 0;
	for (const tile of tiles) {
		if (isBlankTile(tile.pixels)) {
			continue;
		}
		const name = matchTile(tile.pixels, references, taken);
		if (name === null) {
			dropped++;
			continue;
		}
		taken.add(name);
		output.set('texture', `minecraft:${directory}/${name}`, tile.png);
		matched++;
	}
	return { matched, dropped };
}

/**
 * Build an in-memory texture layer for a pre-1.6 jar. `sheets` selects the
 * ≤1.4.7 stitched-sheet path; otherwise the 1.5.x individual-file path.
 */
export async function reshapeLegacyAssets(jarPath: string, referenceJar: string, sheets: boolean): Promise<ResourceManager> {
	const output = new MapResourceManager();
	const [blockReferences, itemReferences] = await Promise.all([
		loadReferences(referenceJar, 'blocks'),
		loadReferences(referenceJar, 'items'),
	]);

	let entries: Map<string, Buffer>;
	if (sheets) {
		entries = await readJarEntries(jarPath, path => ['terrain.png', 'gui/items.png', 'misc/glint.png'].includes(path));
		const terrain = entries.get('terrain.png');
		if (terrain) {
			await matchInto(output, await sheetTiles(terrain), blockReferences, 'blocks');
		}
		const items = entries.get('gui/items.png');
		if (items) {
			await matchInto(output, await sheetTiles(items), itemReferences, 'items');
		}
	} else {
		entries = await readJarEntries(jarPath, path => path.startsWith('textures/') || path === 'misc/glint.png');
		await matchInto(output, await fileTiles(entries, 'textures/blocks/'), blockReferences, 'blocks');
		await matchInto(output, await fileTiles(entries, 'textures/items/'), itemReferences, 'items');
	}
	const glint = entries.get('misc/glint.png');
	if (glint) {
		output.set('texture', 'minecraft:misc/enchanted_glint_item', glint);
	}

	return output;
}
