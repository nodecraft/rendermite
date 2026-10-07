/**
 * The buffered-directory reader replaces yauzl's own file access, so it has to
 * be indistinguishable from it: same entries, same bytes, same errors. Archive
 * comments and stored (uncompressed) entries are the cases most likely to break
 * a hand-rolled end-of-directory search.
 */

import { createWriteStream } from 'node:fs';
import {
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';
import { ZipFile } from 'yazl';

import { openZip } from '../src/resources/zip-reader.ts';

import type { Entry, ZipFile as YauzlZipFile } from 'yauzl';

let directory: string;

const CONTENTS: Record<string, string> = {
	'assets/test/models/item/a.json': '{"parent":"item/generated"}',
	'assets/test/models/item/b.json': `{"comment":"${'x'.repeat(4096)}"}`,
	'assets/test/textures/item/c.txt': 'stored entry, no compression',
};

async function buildZip(file: string, comment?: string): Promise<void> {
	const zip = new ZipFile();
	for (const [name, content] of Object.entries(CONTENTS)) {
		zip.addBuffer(Buffer.from(content), name, { compress: !name.endsWith('.txt') });
	}
	if (comment) {
		zip.end({ comment, forceZip64Format: false });
	} else {
		zip.end();
	}
	await new Promise<void>((resolve, reject) => {
		const out = createWriteStream(file);
		zip.outputStream.pipe(out).on('close', resolve).on('error', reject);
	});
}

async function collectEntries(zip: YauzlZipFile): Promise<Map<string, Entry>> {
	const entries = new Map<string, Entry>();
	await new Promise<void>((resolve, reject) => {
		zip.on('entry', (entry: Entry) => {
			entries.set(entry.fileName, entry);
			zip.readEntry();
		});
		zip.on('end', resolve);
		zip.on('error', reject);
		zip.readEntry();
	});
	return entries;
}

async function readEntry(zip: YauzlZipFile, entry: Entry): Promise<string> {
	return new Promise((resolve, reject) => {
		zip.openReadStream(entry, (err, stream) => {
			if (err) {
				reject(err);
				return;
			}
			const chunks: Buffer[] = [];
			stream.on('data', (chunk) => {
				chunks.push(chunk as Buffer);
			});
			stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
			stream.on('error', reject);
		});
	});
}

async function readAll(zip: YauzlZipFile): Promise<Map<string, string>> {
	const contents = new Map<string, string>();
	for (const [name, entry] of await collectEntries(zip)) {
		contents.set(name, await readEntry(zip, entry));
	}
	return contents;
}

beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), 'rendermite-zip-'));
	await buildZip(path.join(directory, 'plain.zip'));
	await buildZip(path.join(directory, 'commented.zip'), 'a trailing archive comment');
	await writeFile(path.join(directory, 'not-a-zip.bin'), Buffer.alloc(4096, 7));
});

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('openZip', () => {
	it('reads every entry, compressed and stored alike', async () => {
		const zip = await openZip(path.join(directory, 'plain.zip'));
		const contents = await readAll(zip);
		expect(Object.fromEntries(contents)).toEqual(CONTENTS);
		zip.close();
	});

	it('finds the directory behind an archive comment', async () => {
		const zip = await openZip(path.join(directory, 'commented.zip'));
		const contents = await readAll(zip);
		expect(Object.fromEntries(contents)).toEqual(CONTENTS);
		zip.close();
	});

	it('reads the same entry repeatedly from the shared descriptor', async () => {
		const zip = await openZip(path.join(directory, 'plain.zip'));
		const entries = await collectEntries(zip);
		const stored = entries.get('assets/test/textures/item/c.txt')!;
		const compressed = entries.get('assets/test/models/item/b.json')!;
		// Entry data is read positionally, so repeated reads must not disturb the
		// descriptor other reads share.
		expect(await readEntry(zip, stored)).toBe(CONTENTS['assets/test/textures/item/c.txt']);
		expect(await readEntry(zip, compressed)).toBe(CONTENTS['assets/test/models/item/b.json']);
		expect(await readEntry(zip, stored)).toBe(CONTENTS['assets/test/textures/item/c.txt']);
		zip.close();
		const raw = await readFile(path.join(directory, 'plain.zip'));
		expect(raw.length).toBeGreaterThan(0);
	});

	it('falls back to yauzl for anything that is not a zip', async () => {
		await expect(openZip(path.join(directory, 'not-a-zip.bin'))).rejects.toThrow();
		await expect(openZip(path.join(directory, 'missing.zip'))).rejects.toThrow();
	});
});
