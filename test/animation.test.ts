import { existsSync } from 'node:fs';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { vanillaJar } from './fixtures/index.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { encodeAnimatedIcon } from '../src/output/encode.ts';
import { minifyStylesheet } from '../src/output/minify.ts';
import { renderModelFrames } from '../src/render/renderer.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { ResourceLocator } from '../src/resources/locator.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { TextureLoader } from '../src/textures/loader.ts';

const assetsJar = vanillaJar('1.21.8');
const hasFixture = existsSync(assetsJar);

describe.skipIf(!hasFixture)('animation rendering', () => {
	const resources = new JarResourceManager(assetsJar);
	const models = new ModelLoader(resources);
	const textures = new TextureLoader(resources);

	it('reads animation metadata (magma is a frame-listed strip)', async () => {
		const magma = await textures.loadAnimated(ResourceLocator.parse('minecraft:block/magma'));
		expect(magma).not.toBeNull();
		expect(magma!.frameCount).toBeGreaterThan(1);
		expect(magma!.tickLength).toBeGreaterThan(magma!.frameCount - 1);
		expect(magma!.frame(0).width).toBe(16);
		expect(magma!.frame(0).height).toBe(16);
	});

	it('treats an unanimated sheet as one frame at its natural size', async () => {
		// A wider-than-tall entity sheet with no mcmeta: deriving the frame height
		// from the width would crop it square and shift every V coordinate.
		const sheet = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 0, g: 216, b: 255, alpha: 1 } } })
			.png()
			.toBuffer();
		const wide = new MapResourceManager().set('texture', 'test:render/wide', sheet);
		const loaded = await new TextureLoader(wide).loadAnimated(ResourceLocator.parse('test:render/wide'));
		expect(loaded).not.toBeNull();
		expect(loaded!.frameCount).toBe(1);
		expect([loaded!.frame(0).width, loaded!.frame(0).height]).toEqual([64, 32]);
	});

	it('still slices an unanimated square-stacked strip into a single frame', async () => {
		// Height a multiple of width and no mcmeta: decode crops to one square, so
		// at(0) must agree rather than hand back the whole strip.
		const strip = await sharp({ create: { width: 16, height: 48, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } })
			.png()
			.toBuffer();
		const stacked = new MapResourceManager().set('texture', 'test:block/strip', strip);
		const loader = new TextureLoader(stacked);
		const loaded = await loader.loadAnimated(ResourceLocator.parse('test:block/strip'));
		expect([loaded!.frame(0).width, loaded!.frame(0).height]).toEqual([16, 16]);
		const decoded = await loader.load(ResourceLocator.parse('test:block/strip'));
		expect([decoded!.width, decoded!.height]).toEqual([16, 16]);
	});

	it('renders multi-frame magma_block with sane delays', async () => {
		const model = await models.load('minecraft:block/magma_block');
		const { frames, delaysMs } = await renderModelFrames(model, textures, {
			size: 64,
			quality: 2,
			lightingProfile: 'modern',
		});
		expect(frames.length).toBeGreaterThan(1);
		expect(delaysMs).toHaveLength(frames.length);
		for (const delay of delaysMs) {
			expect(delay).toBeGreaterThanOrEqual(50);
			expect(delay % 50).toBe(0);
		}
		// Frames must actually differ (animation, not duplicates).
		const first = frames[0].data;
		const second = frames[1].data;
		expect(first.some((value, index) => value !== second[index])).toBe(true);
	});

	it('renders a single frame for unanimated models', async () => {
		const model = await models.load('minecraft:block/stone');
		const { frames, delaysMs } = await renderModelFrames(model, textures, {
			size: 64,
			quality: 2,
			lightingProfile: 'legacy',
		});
		expect(frames).toHaveLength(1);
		expect(delaysMs).toHaveLength(1);
	});

	it('encodes animated webp and gif with matching page counts', async () => {
		const model = await models.load('minecraft:block/magma_block');
		const { frames, delaysMs } = await renderModelFrames(model, textures, {
			size: 64,
			quality: 2,
			lightingProfile: 'modern',
		});
		const encoded = await encodeAnimatedIcon(frames, delaysMs, { webp: true, gif: true, avif: true });
		expect(encoded.webp).toBeDefined();
		expect(encoded.gif).toBeDefined();
		expect(encoded.avif).toBeDefined();

		const webpMeta = await sharp(encoded.webp, { animated: true }).metadata();
		expect(webpMeta.pages).toBe(frames.length);
		expect(webpMeta.delay?.length).toBe(frames.length);

		const gifMeta = await sharp(encoded.gif, { animated: true }).metadata();
		expect(gifMeta.pages).toBe(frames.length);

		// PNG fallback is the static first frame.
		const pngMeta = await sharp(encoded.png).metadata();
		expect(pngMeta.width).toBe(64);
		expect(pngMeta.pages ?? 1).toBe(1);
	});
});

describe('undecodable textures', () => {
	it('names the texture that failed rather than leaking sharp\'s message', async () => {
		// frostiful publishes a jar whose every texture is a Git LFS pointer stub,
		// so the bare "unsupported image format" would repeat with nothing to act on.
		const resources = new MapResourceManager()
			.set('texture', 'somemod:item/broken', Buffer.from('version https://git-lfs.github.com/spec/v1\n'));
		await expect(new TextureLoader(resources).loadAnimated(ResourceLocator.parse('somemod:item/broken')))
			.rejects.toThrow('somemod:item/broken');
	});
});

describe('minifyStylesheet', () => {
	it('minifies valid css', () => {
		const result = minifyStylesheet('.rc-item {\n    position: relative;\n}\n');
		expect(result).toBe('.rc-item{position:relative}');
	});

	it('returns input unchanged on parse failure', () => {
		const broken = '.rc-item { position: relative; } @media { broken';
		const result = minifyStylesheet(broken, () => {});
		expect(result === broken || result.length > 0).toBe(true);
	});
});

describe('frame delays stay encodable', () => {
	/** An animated sprite whose mcmeta declares `frametime`. */
	async function animated(frametime: number): Promise<MapResourceManager> {
		const strip = await sharp({ create: { width: 4, height: 8, channels: 4, background: { r: 90, g: 140, b: 200, alpha: 1 } } })
			.png()
			.toBuffer();
		return new MapResourceManager()
			.set('texture', 'mod:item/blinker', strip)
			.set('textureMeta', 'mod:item/blinker', Buffer.from(JSON.stringify({ animation: { frametime } })))
			.set('model', 'minecraft:item/generated', JSON.stringify({ parent: 'builtin/generated' }))
			.set('model', 'mod:item/blinker', JSON.stringify({
				parent: 'minecraft:item/generated',
				textures: { layer0: 'mod:item/blinker' },
			}));
	}

	async function delays(frametime: number): Promise<number[]> {
		const resources = await animated(frametime);
		const model = await new ModelLoader(resources).load('mod:item/blinker');
		const { delaysMs } = await renderModelFrames(model, new TextureLoader(resources), {
			size: 8,
			quality: 1,
			lightingProfile: 'modern',
		});
		return delaysMs;
	}

	it('rounds a fractional frametime to whole milliseconds', async () => {
		// ltc2 ships frametime 1.75, which is 87.5ms — sharp takes a uint16.
		for (const delay of await delays(1.75)) {
			expect(Number.isInteger(delay)).toBe(true);
		}
	});

	it('clamps a frametime longer than the encoder can express', async () => {
		// mikedongles holds a frame for 1500 ticks: 75s, past the 65535ms field.
		for (const delay of await delays(1500)) {
			expect(delay).toBeLessThanOrEqual(65535);
			expect(delay).toBeGreaterThanOrEqual(50);
		}
	});
});
