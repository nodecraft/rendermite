import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { vanillaJar } from './fixtures/index.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { toByteTexture } from '../src/render/blend.ts';
import { renderModel } from '../src/render/renderer.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { TextureLoader } from '../src/textures/loader.ts';

import type { Texture } from '../src/textures/loader.ts';

const assetsJar = vanillaJar('1.21.8');
const referenceDir = path.join(import.meta.dirname, '..', '.work', 'golden', '1.21.8');
const dockerReferenceDir = path.join(import.meta.dirname, '..', '.work', 'golden', '1.21.8-docker');
const hasFixture = existsSync(assetsJar)
	&& existsSync(path.join(dockerReferenceDir, 'items', 'minecraft'));

/**
 * References come from a local run of the real renderchest v5.1.0 docker image
 * (`.work/golden/1.21.8-docker/`, see DESIGN.md) — the published corpus is NOT
 * usable as pixel ground truth: its PNGs were palette-quantized and its WebPs
 * are lossy (Imagick's webp:lossless option never took effect upstream).
 */
async function fetchReference(item: string): Promise<Texture> {
	const file = path.join(dockerReferenceDir, 'items', 'minecraft', `${item}.png`);
	const decoded = await sharp(await readFile(file)).ensureAlpha().raw()
		.toBuffer({ resolveWithObject: true });
	return {
		width: decoded.info.width,
		height: decoded.info.height,
		data: new Uint8ClampedArray(decoded.data.buffer, decoded.data.byteOffset, decoded.data.length),
	};
}

interface PixelDiff {
	differing: number;
	maxChannelDelta: number;
}

function comparePixels(actual: Texture, expected: Texture, channelTolerance: number): PixelDiff {
	expect(actual.width).toBe(expected.width);
	expect(actual.height).toBe(expected.height);
	let differing = 0;
	let maxChannelDelta = 0;
	for (let offset = 0; offset < actual.data.length; offset += 4) {
		// Fully transparent pixels compare equal regardless of RGB.
		if (actual.data[offset + 3] === 0 && expected.data[offset + 3] === 0) {
			continue;
		}
		let pixelDiffers = false;
		for (let channel = 0; channel < 4; channel++) {
			const delta = Math.abs(actual.data[offset + channel] - expected.data[offset + channel]);
			maxChannelDelta = Math.max(maxChannelDelta, delta);
			if (delta > channelTolerance) {
				pixelDiffers = true;
			}
		}
		if (pixelDiffers) {
			differing++;
		}
	}
	return { differing, maxChannelDelta };
}

async function saveDebugImage(texture: Texture, name: string): Promise<void> {
	await mkdir(referenceDir, { recursive: true });
	await sharp(Buffer.from(texture.data.buffer, texture.data.byteOffset, texture.data.length), {
		raw: { width: texture.width, height: texture.height, channels: 4 },
	}).png().toFile(path.join(referenceDir, name));
}

describe.skipIf(!hasFixture)('golden comparison against published renderchest output (1.21.8, v5.1.0)', () => {
	const resources = new JarResourceManager(assetsJar);
	const models = new ModelLoader(resources);
	const textures = new TextureLoader(resources);

	// Every case must match the published corpus EXACTLY (tolerance 0): the
	// renderer reproduces v5.1.0 byte-for-byte, including its iterator row-shift
	// quirk, Q16 quantization, and the PNG encoder's truncating quantum scale.
	const exactCases: Array<[item: string, model: string]> = [
		['diamond_sword', 'minecraft:item/diamond_sword'],
		['stick', 'minecraft:item/stick'],
		['stone', 'minecraft:block/stone'],
		['crafting_table', 'minecraft:block/crafting_table'],
		['furnace', 'minecraft:block/furnace'],
		['glass', 'minecraft:block/glass'],
		['oak_stairs', 'minecraft:block/oak_stairs'],
		['oak_slab', 'minecraft:block/oak_slab'],
		['oak_fence', 'minecraft:block/oak_fence_inventory'],
	];

	it.each(exactCases)('renders %s pixel-identical to the published corpus', async (item, modelLocator) => {
		const model = await models.load(modelLocator);
		const rendered = toByteTexture(await renderModel(model, textures, {
			size: 64,
			quality: 2,
			lightingProfile: 'legacy',
		}));
		const reference = await fetchReference(item);
		const diff = comparePixels(rendered, reference, 0);
		if (diff.differing > 0) {
			await saveDebugImage(rendered, `${item}.actual.png`);
		}
		expect(diff.differing).toBe(0);
	});
});
