/**
 * Optional integration suite over real third-party mod jars, which are
 * license-restricted and never committed. Point RENDERMITE_MODJARS at a
 * directory of jars (subdirectory `oldera/` for 1.7.10-era ones) to enable —
 * everything here skips silently otherwise. The committed synthetic fixtures
 * in mods.test.ts cover the same code paths deterministically.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { ensureVanillaJar, realModJarsDir } from './fixtures/index.ts';
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
import { prepareVersionResources } from '../src/versions/prepare.ts';

import type { FloatTexture } from '../src/render/blend.ts';
import type { Texture } from '../src/textures/loader.ts';

interface RealModCase {
	label: string;
	jars: string[];
	vanillaVersion: string;
	namespaces: string[];
	coverageFloor: number;
}

const CASES: RealModCase[] = [
	{
		label: 'thermal_dynamics + foundation + cofh_core (Forge 1.20.1)',
		jars: [
			'thermal_dynamics-1.20.1-11.0.1.23.jar',
			'thermal_foundation-1.20.1-11.0.6.70.jar',
			'cofh_core-1.20.1-11.0.2.56.jar',
		],
		vanillaVersion: '1.20.4',
		namespaces: ['thermal', 'cofh_core'],
		coverageFloor: 0.9,
	},
	{
		label: 'create (Forge 1.20.1)',
		jars: ['create-1.20.1-6.0.8.jar'],
		vanillaVersion: '1.20.4',
		namespaces: ['create'],
		coverageFloor: 0.9,
	},
	{
		label: 'botania (Forge 1.20.1)',
		jars: ['Botania-1.20.1-454-FORGE.jar'],
		vanillaVersion: '1.20.4',
		namespaces: ['botania'],
		coverageFloor: 0.85,
	},
	{
		label: 'create-fabric (1.20.1)',
		jars: ['create-fabric-6.0.8.1+build.1744-mc1.20.1.jar'],
		vanillaVersion: '1.20.4',
		namespaces: ['create'],
		coverageFloor: 0.85,
	},
	{
		label: 'bartering station (NeoForge 26.2)',
		jars: ['BarteringStation-v26.2.0-mc26.2.x-NeoForge.jar'],
		vanillaVersion: '1.21.8',
		namespaces: ['barteringstation'],
		coverageFloor: 0.9,
	},
	{
		label: 'sophisticatedbackpacks + core (Forge 1.20.1)',
		jars: ['sophisticatedbackpacks-1.20.1-3.24.63.2049.jar', 'sophisticatedcore-1.20.1-1.2.9.21.168.jar'],
		vanillaVersion: '1.20.4',
		namespaces: ['sophisticatedbackpacks'],
		coverageFloor: 0.8,
	},
	{
		label: 'tinkers construct (1.7.10)',
		jars: ['oldera/tinkers-construct-1.7.10.jar'],
		vanillaVersion: '1.7.10',
		namespaces: ['tinker'],
		coverageFloor: 0.5,
	},
	{
		label: 'industrial craft 2 (1.7.10)',
		jars: ['oldera/industrial-craft-1.7.10.jar'],
		vanillaVersion: '1.7.10',
		namespaces: ['ic2'],
		coverageFloor: 0.5,
	},
];

const jarsRoot = realModJarsDir();
const available = jarsRoot === null
	? []
	: CASES.filter(entry => entry.jars.every(name => existsSync(path.join(jarsRoot, name))));

function hasContent(texture: Texture): boolean {
	for (let offset = 3; offset < texture.data.length; offset += 4) {
		if (texture.data[offset] > 0) {
			return true;
		}
	}
	return false;
}

function isAllBlack(texture: Texture): boolean {
	let opaque = 0;
	let black = 0;
	for (let offset = 0; offset < texture.data.length; offset += 4) {
		if (texture.data[offset + 3] <= 128) {
			continue;
		}

		opaque++;
		if (texture.data[offset] < 12 && texture.data[offset + 1] < 12 && texture.data[offset + 2] < 12) {
			black++;
		}
	}
	return opaque > 0 && black / opaque > 0.95;
}

// describe.each cannot take an empty table; register a placeholder instead.
if (available.length === 0) {
	describe('real mods (RENDERMITE_MODJARS not set)', () => {
		it.skip('skipped — point RENDERMITE_MODJARS at a directory of jars', () => {});
	});
}

describe.skipIf(available.length === 0).each(available.length > 0 ? available : [CASES[0]])('real mod: $label', (entry) => {
	it('renders with acceptable coverage', async () => {
		const root = jarsRoot as string;
		const vanilla = entry.vanillaVersion === '1.7.10'
			? await prepareVersionResources({
				version: '1.7.10',
				jar: await ensureVanillaJar('1.7.10'),
				donors: {
					'1.8.9': await ensureVanillaJar('1.8.9'),
					'1.12.2': await ensureVanillaJar('1.12.2'),
				},
			})
			: new JarResourceManager(await ensureVanillaJar(entry.vanillaVersion));
		const preparation = await prepareModResources({
			jars: entry.jars.map(name => path.join(root, name)),
			vanilla,
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
					if (hasContent(icon) && !isAllBlack(icon)) {
						rendered++;
					} else {
						failed++;
						if (failures.length < 10) {
							failures.push(items[i].id);
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
