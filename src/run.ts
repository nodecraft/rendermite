/**
 * Render-run orchestration: discover items, evaluate definitions, render,
 * encode, write images + stylesheet + item list. Unlike upstream, failures are
 * per-item, collected, and reported — a run summary counts files, never log lines.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadAtlasResolver } from './atlas/registry.ts';
import { builtinDynamicResources } from './dynamic/generators.ts';
import { defaultProperties, evaluateItemModel } from './items/definition.ts';
import { discoverItems, resolveItem } from './items/discovery.ts';
import { ModelLoader } from './models/loader.ts';
import { encodeAnimatedIcon } from './output/encode.ts';
import { classifyItemStyle } from './output/item-styles.ts';
import { minifyStylesheet } from './output/minify.ts';
import { generateStylesheet } from './output/stylesheet.ts';
import { blendPixel, toFloatTexture } from './render/blend.ts';
import { renderDyedVariantFallback, renderEntityFallback, spawnEggTints } from './render/entity-fallback.ts';
import { findGeoForItem, renderGeo } from './render/geo.ts';
import { legacyTintsForChain } from './render/legacy-tints.ts';
import {
	boxDownscale,
	pointResize,
	renderModel,
	renderModelFrames,
} from './render/renderer.ts';
import { resolveTints } from './render/tints.ts';
import { ResourceLocator } from './resources/locator.ts';
import { FolderResourceManager, LayeredResourceManager } from './resources/manager.ts';
import { TextureLoader } from './textures/loader.ts';

import type { ItemStyle } from './output/stylesheet.ts';
import type { FloatTexture } from './render/blend.ts';
import type { LightingProfileName } from './render/lighting.ts';
import type { ResourceManager } from './resources/manager.ts';

export interface RunOptions {
	resources: ResourceManager;
	/**
	 * Path to a renderchest-style builtin pack (`<dir>/<ns>/…`). Layered ABOVE
	 * user assets, matching upstream: its item overrides (chests, banners,
	 * shulkers, heads) shadow vanilla's code-drawn items.
	 */
	builtin?: string;
	output: string;
	namespaces?: string[];
	size?: number;
	quality?: number;
	prefix?: string;
	format?: 'webp' | 'avif';
	fallback?: boolean;
	/** Also emit animated GIFs for legacy browsers. */
	gif?: boolean;
	/** Also emit AVIF (animated where libvips supports it, else first frame). */
	avif?: boolean;
	/** Minify the stylesheet via lightningcss (default true). */
	minify?: boolean;
	/** In-flight items (encode overlaps on libvips' threadpool; default 8). */
	concurrency?: number;
	lightingProfile?: LightingProfileName;
	itemList?: boolean;
	onProgress?: (done: number, total: number, id: string, error?: string) => void;
}

export interface ItemFailure {
	id: string;
	error: string;
}

export interface RunResult {
	rendered: string[];
	failed: ItemFailure[];
	/**
	 * Items whose real model is code-rendered (no drawable geometry) but which
	 * ship a flat item sprite we rendered instead. Reported, never silent.
	 */
	spriteFallbacks: string[];
	/**
	 * Ids whose model is a parent template other item models extend (spectrum's
	 * handheld_oversized) — not real items, so their failure is reported apart
	 * from genuine misses.
	 */
	skippedTemplates: string[];
	/** Files actually written, the only trustworthy success signal. */
	writtenFiles: number;
}

export async function run(options: RunOptions): Promise<RunResult> {
	const namespaces = options.namespaces ?? ['minecraft'];
	const size = options.size ?? 64;
	const quality = options.quality ?? 2;
	const prefix = options.prefix ?? 'rc-';
	const lightingProfile = options.lightingProfile ?? 'modern';

	// Dynamic resources (pot variants, leather trim layers, charged crossbows)
	// depend on builtin models, so they ride along with the builtin pack.
	const dynamic = options.builtin ? builtinDynamicResources() : null;
	const resources = options.builtin && dynamic
		? new LayeredResourceManager([new FolderResourceManager(options.builtin), dynamic.layer, options.resources])
		: options.resources;
	const models = new ModelLoader(resources);
	const textures = new TextureLoader(resources);
	// Atlas sources synthesize sprites with no file behind them (armor trims via
	// paletted_permutations, unstitch regions) — the class renderchest v2.5.2
	// resolved nothing for.
	textures.setAtlasResolver(await loadAtlasResolver(resources, locator => textures.load(locator)));

	const ids: string[] = [];
	const seen = new Set<string>();
	// The stylesheet's base rules reference the placeholder icons; upstream
	// prepends them to every item list for the same reason.
	if (options.builtin) {
		for (const placeholder of ['renderchest:unknown', 'renderchest:empty']) {
			seen.add(placeholder);
			ids.push(placeholder);
		}
	}
	for (const namespace of namespaces) {
		for (const item of await discoverItems(resources, namespace)) {
			if (seen.has(item.id)) {
				continue;
			}
			// The builtin pack declares overrides for every version's special items
			// (copper chests, mannequins). Ones the target version does not itself
			// declare are not items there — rendering them is upstream's prune-retry
			// failure mode, so require the id to exist beneath the builtin layer.
			if (options.builtin && !(await itemExistsIn(options.resources, item.id))) {
				continue;
			}
			seen.add(item.id);
			ids.push(item.id);
		}
	}
	// Dynamic items belong to vanilla renders only, matching upstream's
	// generators — and each group only exists where its prerequisites do
	// (1.12.2 has no trims, pots, or crossbows).
	if (dynamic && namespaces.includes('minecraft')) {
		const hasTrims = await resources.hasResource('texture', ResourceLocator.parse('minecraft:trims/color_palettes/trim_palette'));
		const hasPot = await resources.hasResource('texture', ResourceLocator.parse('minecraft:entity/decorated_pot/decorated_pot_base'));
		const hasCrossbow = await resources.hasResource('model', ResourceLocator.parse('minecraft:item/crossbow_arrow'));
		const groupAvailable: Record<string, boolean> = {
			_armor_trims: hasTrims,
			_leather_armor: hasTrims,
			_decorated_pot: hasPot,
			_crossbow: hasCrossbow,
		};
		for (const item of dynamic.items) {
			const namespace = item.id.split(':', 1)[0];
			if ((groupAvailable[namespace] ?? true) && !seen.has(item.id)) {
				seen.add(item.id);
				ids.push(item.id);
			}
		}
	}

	const rendered: string[] = [];
	const failed: ItemFailure[] = [];
	const spriteFallbacks: string[] = [];
	const skippedTemplates: string[] = [];
	const styles: ItemStyle[] = [];
	let writtenFiles = 0;

	// Locators (as strings) used as a parent by another item model in the run's
	// namespaces — failing ids that are really templates, built only if needed.
	let templateParents: Promise<Set<string>> | null = null;
	const loadTemplateParents = async (): Promise<Set<string>> => {
		const parents = new Set<string>();
		for (const namespace of namespaces) {
			for (const modelLocator of await resources.listResources('model', namespace)) {
				if (!modelLocator.path.startsWith('item/')) {
					continue;
				}
				const raw = await resources.getResource('model', modelLocator);
				if (!raw) {
					continue;
				}
				try {
					const parent = (JSON.parse(raw.toString('utf8')) as { parent?: string; }).parent;
					if (typeof parent === 'string') {
						parents.add(ResourceLocator.parse(parent).toString());
					}
				} catch {
					// Unparseable models can't extend a template; skip.
				}
			}
		}
		return parents;
	};
	const isTemplateModel = async (id: string): Promise<boolean> => {
		const locator = ResourceLocator.parse(id);
		if (await resources.hasResource('itemDefinition', locator)) {
			return false;
		}
		templateParents ??= loadTemplateParents();
		const parents = await templateParents;
		return parents.has(new ResourceLocator(locator.namespace, `item/${locator.path}`).toString());
	};

	/**
	 * Code-rendered models often still ship a flat item sprite (the old
	 * pipeline's black-icon audit checked exactly this). A real sprite beats
	 * no icon; the fallback is recorded so it is never a silent substitution.
	 */
	const spriteFallback = async (id: string): Promise<FloatTexture | null> => {
		const locator = ResourceLocator.parse(id);
		for (const directory of ['item', 'items']) {
			const texture = await textures.load(new ResourceLocator(locator.namespace, `${directory}/${locator.path}`));
			if (texture) {
				const float = toFloatTexture(texture);
				const upscaled = pointResize(float, size * quality, size * quality);
				return quality === 1 ? upscaled : boxDownscale(upscaled, quality);
			}
		}
		return null;
	};

	// A small async pool: the JS rasterizer shares one thread, but sharp's
	// encoders run on libvips' native threadpool, so overlapping items keeps
	// encode off the critical path.
	const concurrency = Math.max(1, options.concurrency ?? 8);
	let nextIndex = 0;
	let completed = 0;

	const renderFrames = async (id: string): Promise<{ frames: FloatTexture[]; delaysMs: number[]; }> => {
		const instructions = await resolveItem(resources, id, defaultProperties());
		let frames: FloatTexture[];
		let delaysMs: number[];
		{
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
				frames = [combined ?? { width: size, height: size, data: new Float64Array(size * size * 4) }];
				delaysMs = [50];
			}
			if (frames.length === 0) {
				// empty/special items render fully transparent, matching upstream.
				frames = [{ width: size, height: size, data: new Float64Array(size * size * 4) }];
				delaysMs = [50];
			}
		}
		return { frames, delaysMs };
	};

	const renderOne = async (index: number): Promise<void> => {
		const id = ids[index];
		let frames: FloatTexture[];
		let delaysMs: number[];
		let usedFallback = false;
		try {
			({ frames, delaysMs } = await renderFrames(id));
		} catch (err) {
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
			fallbackRender ??= options.builtin
				? await renderEntityFallback(id, models, textures, resources, { size, quality, lightingProfile, resources }).catch(() => null)
				: null;
			// Dyed variants of vanilla items with runtime-generated models.
			fallbackRender ??= await renderDyedVariantFallback(id, models, textures, { size, quality, lightingProfile, resources }).catch(() => null);
			if (fallbackRender) {
				frames = [fallbackRender];
				delaysMs = [50];
			} else {
				const fallback = await spriteFallback(id).catch(() => null);
				if (!fallback) {
					if (await isTemplateModel(id).catch(() => false)) {
						skippedTemplates.push(id);
					} else {
						failed.push({ id, error: (err as Error).message });
					}
					completed++;
					options.onProgress?.(completed, ids.length, id, (err as Error).message);
					return;
				}
				frames = [fallback];
				delaysMs = [50];
				usedFallback = true;
			}
		}
		try {
			const encoded = await encodeAnimatedIcon(frames, delaysMs, {
				webp: true,
				gif: options.gif,
				avif: options.avif,
			});
			const [namespace, itemPath] = id.split(':', 2);
			const imageBase = path.join(options.output, 'items', namespace, `${itemPath}`);
			await mkdir(path.dirname(imageBase), { recursive: true });
			await writeFile(`${imageBase}.png`, encoded.png);
			writtenFiles++;
			for (const [extension, buffer] of [['webp', encoded.webp], ['gif', encoded.gif], ['avif', encoded.avif]] as const) {
				if (!buffer) {
					continue;
				}

				await writeFile(`${imageBase}.${extension}`, buffer);
				writtenFiles++;
			}

			rendered.push(id);
			if (usedFallback) {
				spriteFallbacks.push(id);
			}
			completed++;
			options.onProgress?.(completed, ids.length, id);
		} catch (err) {
			failed.push({ id, error: (err as Error).message });
			completed++;
			options.onProgress?.(completed, ids.length, id, (err as Error).message);
		}
	};

	await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
		while (nextIndex < ids.length) {
			const index = nextIndex++;
			await renderOne(index);
		}
	}));
	// Deterministic outputs regardless of completion order.
	rendered.sort((left, right) => left.localeCompare(right));

	// Styles are classified after the render loop so variant rules only
	// reference dynamic images that actually rendered.
	const renderedSet = new Set(rendered);
	for (const id of rendered) {
		const style = classifyItemStyle(id, renderedSet);
		if (style) {
			styles.push(style);
		}
	}

	const stylesheet = generateStylesheet(styles, {
		prefix,
		format: options.format ?? 'webp',
		fallback: options.fallback ?? true,
	});
	const finalStylesheet = options.minify === false
		? stylesheet
		: minifyStylesheet(stylesheet, message => options.onProgress?.(0, 0, 'stylesheet', message));
	await writeFile(path.join(options.output, `${prefix}${namespaces[0]}-${size}.css`), finalStylesheet);

	if (options.itemList !== false) {
		await writeFile(path.join(options.output, `${prefix}${namespaces[0]}.json`), JSON.stringify(rendered));
		// Failure sidecar: the structured per-item record upstream never had.
		await writeFile(path.join(options.output, `${prefix}${namespaces[0]}-failures.json`), JSON.stringify(failed, null, '\t'));
	}

	return { rendered, failed, spriteFallbacks, skippedTemplates, writtenFiles };
}

async function itemExistsIn(resources: ResourceManager, id: string): Promise<boolean> {
	const locator = ResourceLocator.parse(id);
	if (await resources.hasResource('itemDefinition', locator)) {
		return true;
	}
	return resources.hasResource('model', new ResourceLocator(locator.namespace, `item/${locator.path}`));
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

// Re-export so library consumers can drive custom pipelines with the same pieces.
export { evaluateItemModel };
