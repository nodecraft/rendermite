import {
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	writeFile,
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
import { FolderResourceManager, LayeredResourceManager } from '../src/resources/manager.ts';
import { run } from '../src/run.ts';

import type { RunResult } from '../src/run.ts';

const builtin = builtinPackPath('modern');

function cssTargets(css: string): string[] {
	return new Set(css.matchAll(/url\(["']?([^"')]+)["']?\)/g).map(match => match[1])).values().toArray();
}

describe('run() end to end', () => {
	let output: string;
	let result: RunResult;

	beforeAll(async () => {
		output = await mkdtemp(path.join(tmpdir(), 'renderchest-run-'));
		result = await run({
			// Rendered in-process: test files run in parallel, so a thread pool per
			// run would starve the others. Worker parity has its own suite.
			workers: 1,
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

	it('writes every image referenced by the stylesheet, including both glint formats', async () => {
		const css = await readFile(path.join(output, 'rc-modernmod-64.css'), 'utf8');
		const targets = cssTargets(css);
		expect(targets).toContain('rc-enchantment.png');
		expect(targets).toContain('rc-enchantment.webp');
		for (const target of targets) {
			await expect(readFile(path.join(output, target)), target).resolves.toBeInstanceOf(Buffer);
		}
		for (const target of ['rc-enchantment.png', 'rc-enchantment.webp']) {
			const metadata = await sharp(await readFile(path.join(output, target))).metadata();
			expect(metadata.width, target).toBeGreaterThan(0);
			expect(metadata.height, target).toBeGreaterThan(0);
		}
	});

	it('renders a tree with no glint texture, warning instead of failing the run', async () => {
		const bareOutput = await mkdtemp(path.join(tmpdir(), 'rendermite-noglint-'));
		const warnings: string[] = [];
		try {
			// A mod jar with no vanilla beneath it ships no enchantment glint
			await run({
				workers: 1,
				resources: new JarResourceManager(fixtureModJar('modernmod')),
				builtin,
				output: bareOutput,
				namespaces: ['modernmod'],
				onProgress: (_done, _total, id, error) => {
					if (error && id === 'enchantment glint') {
						warnings.push(error);
					}
				},
			});
			expect(warnings).toHaveLength(1);
			const files = await readdir(bareOutput);
			expect(files.filter(file => file.includes('enchantment'))).toEqual([]);
			const css = await readFile(path.join(bareOutput, 'rc-modernmod-64.css'), 'utf8');
			for (const target of cssTargets(css)) {
				await expect(readFile(path.join(bareOutput, target)), target).resolves.toBeInstanceOf(Buffer);
			}
		} finally {
			await rm(bareOutput, { recursive: true, force: true });
		}
	}, 240000);

	it('writes the item list and the failure sidecar', async () => {
		const list = JSON.parse(await readFile(path.join(output, 'rc-modernmod.json'), 'utf8')) as string[];
		expect(list).toEqual(result.rendered);
		const failures = JSON.parse(await readFile(path.join(output, 'rc-modernmod-failures.json'), 'utf8')) as unknown[];
		expect(failures).toEqual([]);
	});

	it('emits AVIF targets when AVIF is the primary format without a separate --avif flag', async () => {
		const avifOutput = await mkdtemp(path.join(tmpdir(), 'rendermite-avif-'));
		try {
			const avifResult = await run({
				// Rendered in-process: test files run in parallel, so a thread pool per
				// run would starve the others. Worker parity has its own suite.
				workers: 1,
				resources: new JarResourceManager(await ensureVanillaJar('1.21.8')),
				builtin,
				output: avifOutput,
				namespaces: ['empty_fixture'],
				format: 'avif',
				fallback: false,
				itemList: false,
			});
			expect(avifResult.failed).toEqual([]);
			const css = await readFile(path.join(avifOutput, 'rc-empty_fixture-64.css'), 'utf8');
			const targets = cssTargets(css);
			expect(targets).toContain('rc-enchantment.avif');
			expect(targets.every(target => target.endsWith('.avif'))).toBe(true);
			for (const target of targets) {
				await expect(readFile(path.join(avifOutput, target)), target).resolves.toBeInstanceOf(Buffer);
			}
		} finally {
			await rm(avifOutput, { recursive: true, force: true });
		}
	}, 240000);
});

describe('run() tint layer sources', () => {
	const layerTextures = [
		'potion',
		'potion_overlay',
		'splash_potion',
		'lingering_potion',
		'tipped_arrow_base',
		'tipped_arrow_head',
		'firework_star',
		'firework_star_overlay',
		'filled_map',
	];
	let root: string;

	/** A vanilla stand-in holding just the potion, the map and the textures the builtin layer sources read. */
	async function writeTree(dir: string, mapMarkings: boolean): Promise<void> {
		const textures = path.join(dir, 'minecraft', 'textures', 'item');
		await mkdir(textures, { recursive: true });
		await mkdir(path.join(dir, 'minecraft', 'items'), { recursive: true });
		await mkdir(path.join(dir, 'minecraft', 'models', 'item'), { recursive: true });
		const pixel = await sharp({ create: { width: 16, height: 16, channels: 4, background: '#808080' } }).png().toBuffer();
		for (const name of mapMarkings ? [...layerTextures, 'filled_map_markings'] : layerTextures) {
			await writeFile(path.join(textures, `${name}.png`), pixel);
		}
		await writeFile(path.join(dir, 'minecraft', 'models', 'item', 'generated.json'), JSON.stringify({ parent: 'builtin/generated' }));
		for (const item of ['potion', 'filled_map']) {
			await writeFile(path.join(dir, 'minecraft', 'items', `${item}.json`), JSON.stringify({ model: { type: 'minecraft:model', model: `minecraft:item/${item}` } }));
			await writeFile(path.join(dir, 'minecraft', 'models', 'item', `${item}.json`), JSON.stringify({ parent: 'item/generated', textures: { layer0: `item/${item}` } }));
		}
	}

	async function render(mapMarkings: boolean): Promise<{ result: RunResult; css: string; }> {
		const dir = path.join(root, mapMarkings ? 'with-markings' : 'without-markings');
		await writeTree(path.join(dir, 'assets'), mapMarkings);
		const output = path.join(dir, 'out');
		const result = await run({
			workers: 1,
			resources: new FolderResourceManager(path.join(dir, 'assets')),
			builtin,
			output,
			namespaces: ['minecraft'],
			minify: false,
		});
		return { result, css: await readFile(path.join(output, 'rc-minecraft-64.css'), 'utf8') };
	}

	beforeAll(async () => {
		root = await mkdtemp(path.join(tmpdir(), 'rendermite-layers-'));
	});

	afterAll(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it('renders the builtin rc_ layer sources the tinted styles are built from', async () => {
		const { result, css } = await render(true);
		expect(result.failed).toEqual([]);
		expect(result.rendered).toContain('minecraft:rc_potion_content');
		expect(result.rendered).toContain('minecraft:rc_filled_map_overlay');
		expect(css).toContain('--rc-layer-1-tint: #f800f8');
		expect(css).toContain('items/minecraft/rc_filled_map_overlay.webp');
	}, 240000);

	it('leaves filled maps untinted where the markings texture is gone (26.3+)', async () => {
		const { result, css } = await render(false);
		expect(result.failed).toEqual([]);
		expect(result.rendered.filter(id => id.startsWith('minecraft:rc_filled_map_'))).toEqual([]);
		expect(result.rendered).toContain('minecraft:rc_potion_content');
		expect(css).not.toContain('--rc-layer-2-tint: #46402e');
	}, 240000);
});
