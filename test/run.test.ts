import {
	mkdtemp,
	readFile,
	readdir,
	rm,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import sharp from 'sharp';
import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
} from 'vitest';

import { ensureVanillaJar } from './fixtures/index.ts';
import { fixtureModJar } from './fixtures/mods.ts';
import { builtinPackPath } from '../src/builtin.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { LayeredResourceManager } from '../src/resources/manager.ts';
import { run } from '../src/run.ts';

import type { RunResult } from '../src/run.ts';

const builtin = builtinPackPath('modern');

describe('run() end to end', () => {
	let output: string;
	let result: RunResult;

	beforeAll(async () => {
		output = await mkdtemp(path.join(tmpdir(), 'renderchest-run-'));
		result = await run({
			resources: new LayeredResourceManager([
				new JarResourceManager(fixtureModJar('modernmod')),
				new JarResourceManager(await ensureVanillaJar('1.21.8')),
			]),
			builtin,
			output,
			namespaces: ['modernmod'],
			size: 64,
			quality: 2,
			gif: true,
			itemList: true,
		});
	}, 240000);

	afterAll(async () => {
		await rm(output, { recursive: true, force: true });
	});

	it('renders every item in the namespace plus the placeholders, zero failures', () => {
		expect(result.failed).toEqual([]);
		// The stylesheet's base rules need the placeholder icons rendered too.
		expect(result.rendered).toContain('renderchest:unknown');
		expect(result.rendered).toContain('renderchest:empty');
		const modItems = result.rendered.filter(id => id.startsWith('modernmod:'));
		expect(modItems.length).toBeGreaterThan(0);
		expect(modItems.length + 2).toBe(result.rendered.length);
	});

	it('writes png + webp per item and counts the files honestly', async () => {
		const files = await readdir(path.join(output, 'items', 'modernmod'));
		const pngs = files.filter(file => file.endsWith('.png'));
		const webps = files.filter(file => file.endsWith('.webp'));
		const modItems = result.rendered.filter(id => id.startsWith('modernmod:'));
		expect(pngs.length).toBe(modItems.length);
		expect(webps.length).toBe(modItems.length);
		expect(result.writtenFiles).toBeGreaterThanOrEqual(pngs.length + webps.length);
		// Every icon decodes and has visible content — except the deliberately
		// empty item, which must be transparent.
		for (const file of pngs) {
			const image = await sharp(path.join(output, 'items', 'modernmod', file)).ensureAlpha().raw()
				.toBuffer();
			let visible = false;
			for (let offset = 3; offset < image.length; offset += 4) {
				if (image[offset] > 0) {
					visible = true;
					break;
				}
			}
			expect(visible, `${file} visibility`).toBe(file !== 'empty_thing.png');
		}
	});

	it('writes a minified stylesheet honoring the contract', async () => {
		const css = await readFile(path.join(output, 'rc-modernmod-64.css'), 'utf8');
		expect(css).toContain('.rc-item');
		expect(css).toContain('@keyframes rc-enchanted');
		expect(css).toContain('.rc-item.rc-modernmod_gizmo');
		// minified: no indented declarations remain
		expect(css).not.toContain('\n    ');
	});

	it('writes the item list and the failure sidecar', async () => {
		const list = JSON.parse(await readFile(path.join(output, 'rc-modernmod.json'), 'utf8')) as string[];
		expect(list).toEqual(result.rendered);
		const failures = JSON.parse(await readFile(path.join(output, 'rc-modernmod-failures.json'), 'utf8')) as unknown[];
		expect(failures).toEqual([]);
	});
});
