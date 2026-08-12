/**
 * Real-mod integration over jars downloaded from Modrinth at test time —
 * CI-friendly runtime sourcing (cached in .work/fixtures/modrinth/), nothing
 * committed. Kept to a handful of mods spanning loaders and eras; the
 * synthetic fixtures in mods.test.ts remain the exhaustive code-path coverage.
 * Set RENDERMITE_SKIP_ONLINE=1 to skip in offline environments.
 */

import { describe, expect, it } from 'vitest';

import { ensureModrinthJar, ensureVanillaJar } from './fixtures/index.ts';
import { loadAtlasResolver } from '../src/atlas/registry.ts';
import { defaultProperties } from '../src/items/definition.ts';
import { discoverItems, resolveItem } from '../src/items/discovery.ts';
import { ModelLoader } from '../src/models/loader.ts';
import { prepareModResources } from '../src/mods/prepare.ts';
import { blendPixel, toByteTexture } from '../src/render/blend.ts';
import { legacyTintsForChain } from '../src/render/legacy-tints.ts';
import { renderModel } from '../src/render/renderer.ts';
import { resolveTints } from '../src/render/tints.ts';
import { JarResourceManager } from '../src/resources/jar.ts';
import { TextureLoader } from '../src/textures/loader.ts';

import type { ModrinthSpec } from './fixtures/index.ts';
import type { FloatTexture } from '../src/render/blend.ts';
import type { Texture } from '../src/textures/loader.ts';

interface ModrinthCase {
	label: string;
	mods: ModrinthSpec[];
	vanillaVersion: string;
	namespaces: string[];
	coverageFloor: number;
}

const CASES: ModrinthCase[] = [
	{
		// Large Forge mod with custom loader models.
		label: 'create (Forge 1.20.1)',
		mods: [{ slug: 'create', gameVersion: '1.20.1', loader: 'forge', versionNumber: 'mc1.20.1-6.0.8' }],
		vanillaVersion: '1.20.4',
		namespaces: ['create'],
		coverageFloor: 0.9,
	},
	{
		// Cross-jar dependency pair with loader models.
		label: 'sophisticated backpacks + core (Forge 1.20.1)',
		mods: [
			{ slug: 'sophisticated-backpacks', gameVersion: '1.20.1', loader: 'forge' },
			{ slug: 'sophisticated-core', gameVersion: '1.20.1', loader: 'forge' },
		],
		vanillaVersion: '1.20.4',
		namespaces: ['sophisticatedbackpacks'],
		coverageFloor: 0.8,
	},
	{
		// 1.21.4+ items/ definitions on NeoForge.
		label: 'bartering station (NeoForge 26.2)',
		mods: [{ slug: 'bartering-station', gameVersion: '26.2', loader: 'neoforge' }],
		vanillaVersion: '1.21.8',
		namespaces: ['barteringstation'],
		coverageFloor: 0.9,
	},
	{
		// Fabric build of the same era.
		label: 'trading post (Fabric 26.2)',
		mods: [{ slug: 'trading-post', gameVersion: '26.2', loader: 'fabric' }],
		vanillaVersion: '1.21.8',
		namespaces: ['tradingpost'],
		coverageFloor: 0.9,
	},
	{
		// The OBJ-model flagship: 73 OBJ items (revolver, drill, railgun) that
		// the old pipeline classified as permanently unfixable.
		label: 'immersive engineering (Forge 1.20.1, OBJ models)',
		mods: [{ slug: 'immersiveengineering', gameVersion: '1.20.1', loader: 'forge' }],
		vanillaVersion: '1.20.4',
		namespaces: ['immersiveengineering'],
		coverageFloor: 0.9,
	},
];

function hasContent(texture: Texture): boolean {
	for (let offset = 3; offset < texture.data.length; offset += 4) {
		if (texture.data[offset] > 0) {
			return true;
		}
	}
	return false;
}

const online = process.env.RENDERMITE_SKIP_ONLINE !== '1';

describe.skipIf(!online).each(CASES)('modrinth mod: $label', (entry) => {
	it('renders with acceptable coverage', async () => {
		const jars = await Promise.all(entry.mods.map(spec => ensureModrinthJar(spec)));
		const preparation = await prepareModResources({
			jars,
			vanilla: new JarResourceManager(await ensureVanillaJar(entry.vanillaVersion)),
		});
		const textures = new TextureLoader(preparation.resources);
		textures.setAtlasResolver(await loadAtlasResolver(preparation.resources, locator => textures.load(locator)));
		const models = new ModelLoader(preparation.resources);

		let rendered = 0;
		let failed = 0;
		const failures: string[] = [];
		for (const namespace of entry.namespaces) {
			expect(preparation.namespaces).toContain(namespace);
			const items = await discoverItems(preparation.resources, namespace);
			expect(items.length).toBeGreaterThan(0);
			const step = Math.max(1, Math.floor(items.length / 120));
			for (let i = 0; i < items.length; i += step) {
				try {
					const instructions = await resolveItem(preparation.resources, items[i].id, defaultProperties());
					let combined: FloatTexture | null = null;
					for (const instruction of instructions) {
						const model = await models.load(instruction.model);
						const tints = instruction.tints.length > 0
							? await resolveTints(instruction.tints, { textures })
							: await legacyTintsForChain(model.chain, textures) ?? [];
						const result = await renderModel(model, textures, {
							size: 64,
							quality: 2,
							lightingProfile: 'modern',
							itemTransform: instruction.transform,
							tints,
							resources: preparation.resources,
						});
						if (combined === null) {
							combined = result;
						} else {
							for (let offset = 0; offset < combined.data.length; offset += 4) {
								const alpha = result.data[offset + 3];
								if (alpha > 0) {
									blendPixel(combined.data, offset, result.data[offset], result.data[offset + 1], result.data[offset + 2], alpha);
								}
							}
						}
					}
					const icon = toByteTexture(combined ?? { width: 64, height: 64, data: new Float64Array(64 * 64 * 4) });
					if (hasContent(icon)) {
						rendered++;
					} else {
						failed++;
						if (failures.length < 10) {
							failures.push(`${items[i].id} (empty)`);
						}
					}
				} catch (err) {
					failed++;
					if (failures.length < 10) {
						failures.push(`${items[i].id} (${(err as Error).message.slice(0, 60)})`);
					}
				}
			}
		}
		const coverage = rendered / Math.max(1, rendered + failed);
		expect(coverage, `coverage ${(coverage * 100).toFixed(1)}% — failures: ${failures.join('; ')}`).toBeGreaterThanOrEqual(entry.coverageFloor);
	}, 300000);
});
