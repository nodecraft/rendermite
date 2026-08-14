/**
 * The per-item pipeline: asset layering, model/texture loading, the render
 * fallback chain, encoding, and file output. Extracted from run() so a worker
 * thread renders items exactly the way the main thread does — a second
 * implementation would drift, and the failure taxonomy depends on the fallback
 * order being identical everywhere.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { blendPixel, toFloatTexture } from './blend.ts';
import { renderDyedVariantFallback, renderEntityFallback, spawnEggTints } from './entity-fallback.ts';
import { findGeoForItem, renderGeo } from './geo.ts';
import { legacyTintsForChain } from './legacy-tints.ts';
import {
	boxDownscale,
	pointResize,
	renderModel,
	renderModelFrames,
} from './renderer.ts';
import { resolveTints } from './tints.ts';
import { loadAtlasResolver } from '../atlas/registry.ts';
import { builtinDynamicResources } from '../dynamic/generators.ts';
import { defaultProperties } from '../items/definition.ts';
import { resolveItem } from '../items/discovery.ts';
import { ModelLoader } from '../models/loader.ts';
import { encodeAnimatedIcon } from '../output/encode.ts';
import { ResourceLocator } from '../resources/locator.ts';
import { FolderResourceManager, LayeredResourceManager } from '../resources/manager.ts';
import { TextureLoader } from '../textures/loader.ts';

import type { FloatTexture } from './blend.ts';
import type { LightingProfileName } from './lighting.ts';
import type { AnimationLimits } from './renderer.ts';
import type { ResourceManager } from '../resources/manager.ts';

export interface PipelineSettings {
	builtin?: string;
	output: string;
	size: number;
	quality: number;
	format: 'webp' | 'avif';
	gif?: boolean;
	avif?: boolean;
	lightingProfile: LightingProfileName;
	animation?: AnimationLimits;
}

export interface ItemRenderOutcome {
	/** Image files written for the item. */
	written: number;
	/** Whether the item fell back to its flat sprite instead of its model. */
	usedFallback: boolean;
}

export interface RenderedFrames {
	frames: FloatTexture[];
	delaysMs: number[];
}

export class ItemPipeline {
	static async create(base: ResourceManager, settings: PipelineSettings): Promise<ItemPipeline> {
		// Dynamic resources (pot variants, leather trim layers, charged crossbows)
		// depend on builtin models, so they ride along with the builtin pack.
		const dynamic = settings.builtin ? builtinDynamicResources() : null;
		const resources = settings.builtin && dynamic
			? new LayeredResourceManager([new FolderResourceManager(settings.builtin), dynamic.layer, base])
			: base;
		const pipeline = new ItemPipeline(resources, dynamic?.items.map(item => item.id) ?? null, settings);
		// Atlas sources synthesize sprites with no file behind them (armor trims via
		// paletted_permutations, unstitch regions) — the class renderchest v2.5.2
		// resolved nothing for.
		pipeline.textures.setAtlasResolver(await loadAtlasResolver(resources, locator => pipeline.textures.load(locator)));
		return pipeline;
	}

	private readonly settings: PipelineSettings;
	private readonly models: ModelLoader;
	private readonly textures: TextureLoader;
	private readonly createdDirectories = new Set<string>();
	/** The layered tree actually rendered (builtin + dynamic above the input). */
	readonly resources: ResourceManager;
	/** Dynamic vanilla items (trims, pots, crossbows), or null without a builtin pack. */
	readonly dynamicItems: string[] | null;

	private constructor(resources: ResourceManager, dynamicItems: string[] | null, settings: PipelineSettings) {
		this.resources = resources;
		this.dynamicItems = dynamicItems;
		this.settings = settings;
		this.models = new ModelLoader(resources);
		this.textures = new TextureLoader(resources);
	}

	/**
	 * Code-rendered models often still ship a flat item sprite (the old
	 * pipeline's black-icon audit checked exactly this). A real sprite beats
	 * no icon; the fallback is recorded so it is never a silent substitution.
	 */
	private async spriteFallback(id: string): Promise<FloatTexture | null> {
		const { size, quality } = this.settings;
		const locator = ResourceLocator.parse(id);
		for (const directory of ['item', 'items']) {
			const texture = await this.textures.load(new ResourceLocator(locator.namespace, `${directory}/${locator.path}`));
			if (texture) {
				const upscaled = pointResize(toFloatTexture(texture), size * quality, size * quality);
				return quality === 1 ? upscaled : boxDownscale(upscaled, quality);
			}
		}
		return null;
	}

	/** Render an item's frames from its own model, without any fallback. */
	async renderFrames(id: string): Promise<RenderedFrames> {
		const { size, quality, lightingProfile, animation } = this.settings;
		const { resources, models, textures } = this;
		const instructions = await resolveItem(resources, id, defaultProperties());
		let frames: FloatTexture[];
		let delaysMs: number[];
		if (instructions.length === 1) {
			const model = await models.load(instructions[0].model);
			let tints = instructions[0].tints.length > 0
				? await resolveTints(instructions[0].tints, { textures })
				: await legacyTintsForChain(model.chain, textures);
			// Mod spawn eggs carry their colors in item-registration code —
			// derive them from the mob's entity texture instead.
			if (!tints && model.chain.some(entry => entry.endsWith('item/template_spawn_egg'))) {
				tints = await spawnEggTints(id, resources, textures).catch(() => null);
			}
			tints ??= [];
			const result = await renderModelFrames(model, textures, {
				size,
				quality,
				lightingProfile,
				itemTransform: instructions[0].transform,
				tints,
				resources,
				animation,
			});
			frames = result.frames;
			delaysMs = result.delaysMs;
		} else {
			// Composites blend statically at tick 0 — per-part animations with
			// different timelines are rare and not worth the timeline merge.
			let combined: FloatTexture | null = null;
			for (const instruction of instructions) {
				const model = await models.load(instruction.model);
				// Pre-definition eras carry no tints[] — fall back to the classic
				// hard-coded tables (spawn eggs, potions, foliage colormaps).
				const tints = instruction.tints.length > 0
					? await resolveTints(instruction.tints, { textures })
					: await legacyTintsForChain(model.chain, textures) ?? [];
				const renderedModel = await renderModel(model, textures, {
					size,
					quality,
					lightingProfile,
					itemTransform: instruction.transform,
					tints,
					resources,
				});
				combined = combined === null ? renderedModel : blendOver(combined, renderedModel);
			}
			frames = [combined ?? blankFrame(size)];
			delaysMs = [50];
		}
		if (frames.length === 0) {
			// empty/special items render fully transparent, matching upstream.
			frames = [blankFrame(size)];
			delaysMs = [50];
		}
		return { frames, delaysMs };
	}

	/**
	 * Frames for an item, falling back through the same-name block model,
	 * GeckoLib geometry, builtin entity geometry, dyed variants, and finally the
	 * flat sprite. Rethrows the item's own error when nothing draws it.
	 */
	async renderFramesWithFallback(id: string): Promise<RenderedFrames & { usedFallback: boolean; }> {
		try {
			return { ...await this.renderFrames(id), usedFallback: false };
		} catch (err) {
			const { size, quality, lightingProfile, builtin } = this.settings;
			const { resources, models, textures } = this;
			// A same-name block model is what the game itself draws for most
			// block items whose item model is a code loader (IE's coresample).
			const blockLocator = ResourceLocator.parse(id);
			const blockRender = await models.load(new ResourceLocator(blockLocator.namespace, `block/${blockLocator.path}`))
				.then(model => renderModel(model, textures, { size, quality, lightingProfile, resources }))
				.catch(() => null);
			// GeckoLib-style items keep their geometry in Bedrock .geo.json files
			// the game only reaches through Java code — render those directly.
			const geo = blockRender ? null : await findGeoForItem(resources, id).catch(() => null);
			const geoRender = geo
				? await renderGeo(geo.geo, geo.texture, textures, { size, quality, lightingProfile }).catch(() => null)
				: null;
			// renderGeo returns full supersampled size; the other fallbacks go
			// through renderModel, which already downscales.
			let fallbackRender = blockRender
				?? (geoRender && quality !== 1 ? boxDownscale(geoRender, quality) : geoRender);
			// Code-rendered chests/heads/banners/shulkers map onto builtin geometry.
			fallbackRender ??= builtin
				? await renderEntityFallback(id, models, textures, resources, { size, quality, lightingProfile, resources }).catch(() => null)
				: null;
			// Dyed variants of vanilla items with runtime-generated models.
			fallbackRender ??= await renderDyedVariantFallback(id, models, textures, { size, quality, lightingProfile, resources }).catch(() => null);
			if (fallbackRender) {
				return { frames: [fallbackRender], delaysMs: [50], usedFallback: false };
			}
			const sprite = await this.spriteFallback(id).catch(() => null);
			if (!sprite) {
				throw err;
			}
			return { frames: [sprite], delaysMs: [50], usedFallback: true };
		}
	}

	/** Render, encode and write one item. Throws when the item cannot be drawn. */
	async renderItem(id: string): Promise<ItemRenderOutcome> {
		const { frames, delaysMs, usedFallback } = await this.renderFramesWithFallback(id);
		const encoded = await encodeAnimatedIcon(frames, delaysMs, {
			webp: true,
			gif: this.settings.gif,
			avif: this.settings.avif || this.settings.format === 'avif',
		});
		const [namespace, itemPath] = id.split(':', 2);
		const imageBase = path.join(this.settings.output, 'items', namespace, itemPath);
		const directory = path.dirname(imageBase);
		if (!this.createdDirectories.has(directory)) {
			await mkdir(directory, { recursive: true });
			this.createdDirectories.add(directory);
		}
		await writeFile(`${imageBase}.png`, encoded.png);
		let written = 1;
		for (const [extension, buffer] of [['webp', encoded.webp], ['gif', encoded.gif], ['avif', encoded.avif]] as const) {
			if (!buffer) {
				continue;
			}

			await writeFile(`${imageBase}.${extension}`, buffer);
			written++;
		}
		return { written, usedFallback };
	}
}

function blankFrame(size: number): FloatTexture {
	return { width: size, height: size, data: new Float64Array(size * size * 4) };
}

function blendOver(base: FloatTexture, layer: FloatTexture): FloatTexture {
	for (let offset = 0; offset < base.data.length; offset += 4) {
		const alpha = layer.data[offset + 3];
		if (alpha > 0) {
			blendPixel(base.data, offset, layer.data[offset], layer.data[offset + 1], layer.data[offset + 2], alpha);
		}
	}
	return base;
}
