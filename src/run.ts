/**
 * Render-run orchestration: discover items, evaluate definitions, render,
 * encode, write images + stylesheet + item list. Unlike upstream, failures are
 * per-item, collected, and reported — a run summary counts files, never log lines.
 *
 * Items render in worker threads when the resource tree can describe itself
 * (see resources/descriptor.ts); otherwise the same pipeline runs in-process.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


import { discoverItems } from './items/discovery.ts';
import { curatedModelOverrides } from './mods/models.ts';
import { encodeRasterAsset } from './output/encode.ts';
import { classifyItemStyle } from './output/item-styles.ts';
import { minifyStylesheet } from './output/minify.ts';
import { generateStylesheet } from './output/stylesheet.ts';
import { ItemPipeline } from './render/pipeline.ts';
import { describeResources } from './resources/descriptor.ts';
import { ResourceLocator } from './resources/locator.ts';
import { LayeredResourceManager } from './resources/manager.ts';
import { WorkerRenderPool } from './workers/pool.ts';

import type { ItemStyle } from './output/stylesheet.ts';
import type { LightingProfileName } from './render/lighting.ts';
import type { ItemRenderOutcome } from './render/pipeline.ts';
import type { AnimationLimits } from './render/renderer.ts';
import type { ResourceManager } from './resources/manager.ts';
import type { RenderWorkerData } from './workers/render-worker.ts';

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
	/** In-flight items per thread (encode overlaps on libvips' threadpool; default 8). */
	concurrency?: number;
	/**
	 * Render threads. Defaults to one per core (minus the main thread). 1 renders
	 * in-process; a resource tree that cannot be described falls back to that too.
	 */
	workers?: number;
	/** Bounds on animated timelines (frame count). */
	animation?: AnimationLimits;
	/**
	 * Drop classic item models with no matching translation (default true).
	 * Disable for a prepared asset tree whose own preprocessing has already
	 * filtered synthesized models and where every real model must be retained.
	 */
	filterUntranslatedModels?: boolean;
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
	/** Image files actually written, the only trustworthy success signal. */
	writtenFiles: number;
	/** Worker threads used; 1 means everything rendered in-process. */
	workers: number;
}

export async function run(options: RunOptions): Promise<RunResult> {
	const namespaces = options.namespaces ?? ['minecraft'];
	const size = options.size ?? 64;
	const quality = options.quality ?? 2;
	const prefix = options.prefix ?? 'rc-';
	const format = options.format ?? 'webp';
	const fallback = options.fallback ?? true;
	const lightingProfile = options.lightingProfile ?? 'modern';
	const settings = {
		builtin: options.builtin,
		output: options.output,
		size,
		quality,
		format,
		gif: options.gif,
		avif: options.avif,
		lightingProfile,
		animation: options.animation,
	};

	/*
	 * Curated geometry for code-drawn (`builtin/entity`) mod items must shadow the
	 * stub the mod itself ships, and layers resolve first-hit — so it goes above
	 * the caller's tree, not below. Callers that pass an assembled pack rather than
	 * jars (the icon pipeline) otherwise never reach it and lose every curated item.
	 */
	const resourceTree = new LayeredResourceManager([curatedModelOverrides(), options.resources]);

	// Workers spawn before discovery so their asset indexing overlaps it; a tree
	// that cannot describe itself renders in-process instead.
	const concurrency = Math.max(1, options.concurrency ?? 8);
	const requestedWorkers = resolveWorkerCount(options.workers);
	const descriptor = requestedWorkers > 1 ? describeResources(resourceTree) : null;
	const pool = descriptor
		? new WorkerRenderPool<ItemRenderOutcome>({
			workerUrl: workerUrl(),
			workerData: {
				resources: descriptor,
				settings,
				// libvips threads are per process, so each worker would otherwise
				// start a machine-sized pool and oversubscribe the CPU N times.
				sharpConcurrency: Math.max(1, Math.round(os.availableParallelism() / requestedWorkers)),
			} satisfies RenderWorkerData,
			workers: requestedWorkers,
			inFlight: concurrency,
		})
		: null;
	const usedWorkers = pool ? requestedWorkers : 1;

	const pipeline = await ItemPipeline.create(resourceTree, settings).catch(async (err: unknown) => {
		await pool?.close();
		throw err;
	});
	const { resources } = pipeline;
	// A tree without vanilla textures has no glint; its items still render, they just cannot shimmer
	const glint = await resolveEnchantmentGlint(resources);
	if (!glint) {
		options.onProgress?.(0, 0, 'enchantment glint', 'Missing enchantment glint texture (minecraft:misc/enchanted_glint_item or enchanted_item_glint); the stylesheet has no glint overlay');
	}
	const glintFormats = fallback ? ['png', format] as const : [format] as const;
	const encodedGlint = glint ? await encodeRasterAsset(glint, glintFormats) : new Map<string, Buffer>();

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
	const hasMapMarkings = await resources.hasResource('texture', ResourceLocator.parse('minecraft:item/filled_map_markings'));
	for (const namespace of namespaces) {
		for (const item of await discoverItems(resources, namespace, {
			filterUntranslatedModels: options.filterUntranslatedModels,
		})) {
			if (seen.has(item.id)) {
				continue;
			}
			// The builtin pack declares overrides for every version's special items
			// (copper chests, mannequins). Ones the target version does not itself
			// declare are not items there — rendering them is upstream's prune-retry
			// failure mode, so require the id to exist beneath the builtin layer.
			// Deliberately the caller's own tree, not the curated layer: curated
			// supplies geometry for items a pack already has, never new items.
			// The modern pack's rc_* definitions are tint layer sources, never real items. The legacy
			// pack's rc_* leather models are superseded by `_leather_armor`, so they stay out.
			const layerSource = item.source === 'definition' && item.id.startsWith('minecraft:rc_');
			if (layerSource) {
				// 26.3 dropped the markings layer, so its maps are a single untinted icon
				if (item.id.startsWith('minecraft:rc_filled_map_') && !hasMapMarkings) {
					continue;
				}
			} else if (options.builtin && !(await itemExistsIn(options.resources, item.id))) {
				continue;
			}
			seen.add(item.id);
			ids.push(item.id);
		}
	}
	// Dynamic items belong to vanilla renders only, matching upstream's
	// generators — and each group only exists where its prerequisites do
	// (1.12.2 has no trims, pots, or crossbows).
	if (pipeline.dynamicItems && namespaces.includes('minecraft')) {
		const hasTrims = await resources.hasResource('texture', ResourceLocator.parse('minecraft:trims/color_palettes/trim_palette'));
		const hasPot = await resources.hasResource('texture', ResourceLocator.parse('minecraft:entity/decorated_pot/decorated_pot_base'));
		const hasCrossbow = await resources.hasResource('model', ResourceLocator.parse('minecraft:item/crossbow_arrow'));
		const groupAvailable: Record<string, boolean> = {
			_armor_trims: hasTrims,
			_leather_armor: hasTrims,
			_decorated_pot: hasPot,
			_crossbow: hasCrossbow,
		};
		for (const id of pipeline.dynamicItems) {
			const namespace = id.split(':', 1)[0];
			if (!(groupAvailable[namespace] ?? true) || seen.has(id)) {
				continue;
			}
			seen.add(id);
			ids.push(id);
		}
	}

	const rendered: string[] = [];
	const failed: ItemFailure[] = [];
	const spriteFallbacks: string[] = [];
	const skippedTemplates: string[] = [];
	const styles: ItemStyle[] = [];
	let writtenFiles = 0;
	await mkdir(options.output, { recursive: true });
	for (const [extension, buffer] of encodedGlint) {
		await writeFile(path.join(options.output, `${prefix}enchantment.${extension}`), buffer);
		writtenFiles++;
	}

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

	let completed = 0;
	const record = async (id: string, outcome: ItemRenderOutcome | null, error?: string): Promise<void> => {
		if (outcome) {
			writtenFiles += outcome.written;
			rendered.push(id);
			if (outcome.usedFallback) {
				spriteFallbacks.push(id);
			}
		} else if (await isTemplateModel(id).catch(() => false)) {
			skippedTemplates.push(id);
		} else {
			failed.push({ id, error: error ?? 'Unknown render failure' });
		}
		completed++;
		options.onProgress?.(completed, ids.length, id, outcome ? undefined : error);
	};

	if (pool) {
		const pending: Array<Promise<void>> = [];
		await pool.run(ids.map((id) => {
			return { id };
		}), (message) => {
			pending.push(record(message.id, message.result ?? null, message.error));
		});
		await Promise.all(pending);
	} else {
		// A small async pool: the JS rasterizer shares one thread, but sharp's
		// encoders run on libvips' native threadpool, so overlapping items keeps
		// encode off the critical path.
		let nextIndex = 0;
		await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
			while (nextIndex < ids.length) {
				const id = ids[nextIndex++];
				try {
					await record(id, await pipeline.renderItem(id));
				} catch (err) {
					await record(id, null, (err as Error).message);
				}
			}
		}));
	}
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
		format,
		fallback,
		glint: glint !== null,
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

	return { rendered, failed, spriteFallbacks, skippedTemplates, writtenFiles, workers: usedWorkers };
}

/**
 * One thread per core less the orchestrator, capped at 8: measured throughput
 * on a 16-thread host peaks around 4-8 workers and falls off above that, where
 * per-worker asset caches and libvips threads start competing for the same cores.
 */
function resolveWorkerCount(requested: number | undefined): number {
	if (requested !== undefined) {
		return Math.max(1, Math.floor(requested));
	}
	return Math.min(8, Math.max(1, os.availableParallelism() - 1));
}

/** The worker's own file, in whichever form this module was loaded from. */
function workerUrl(): URL {
	const extension = path.extname(fileURLToPath(import.meta.url)) || '.js';
	return new URL(`./workers/render-worker${extension}`, import.meta.url);
}

async function itemExistsIn(resources: ResourceManager, id: string): Promise<boolean> {
	const locator = ResourceLocator.parse(id);
	if (await resources.hasResource('itemDefinition', locator)) {
		return true;
	}
	return resources.hasResource('model', new ResourceLocator(locator.namespace, `item/${locator.path}`));
}

/** Resolve both names used on either side of Minecraft 1.19.3. */
async function resolveEnchantmentGlint(resources: ResourceManager): Promise<Buffer | null> {
	for (const path of ['misc/enchanted_glint_item', 'misc/enchanted_item_glint']) {
		const texture = await resources.getResource('texture', new ResourceLocator('minecraft', path));
		if (texture) {
			return texture;
		}
	}
	return null;
}

// Re-export so library consumers can drive custom pipelines with the same pieces.


export { evaluateItemModel } from './items/definition.ts';
