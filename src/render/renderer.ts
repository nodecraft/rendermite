/**
 * Item rendering entry: flat generated items (2D layer compositing) and 3D
 * element models (transform → rasterize → per-pixel composite), both rendered
 * at size × quality then box-downscaled, matching upstream ItemRenderTask.
 */

import { blendPixel, tintTexture, toFloatTexture } from './blend.ts';
import { combineFaceBuffers } from './compose.ts';
import { faceMaxZ, renderFace } from './face.ts';
import { paintBucketFluid } from './fluid-bucket.ts';
import { buildElementFaces } from './geometry.ts';
import { lightsForProfile } from './lighting.ts';
import { renderObjModel } from './obj.ts';
import { displayMatrix, identity, multiply } from './vector.ts';
import { resolveTexture } from '../models/loader.ts';

import type { FloatTexture } from './blend.ts';
import type { RenderableFace, TintColor } from './face.ts';
import type { LightingProfileName } from './lighting.ts';
import type { Mat4, Vec3 } from './vector.ts';
import type { ResolvedModel } from '../models/loader.ts';
import type { ResourceLocator } from '../resources/locator.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { AnimatedTexture, Texture, TextureLoader } from '../textures/loader.ts';

export interface RenderOptions {
	size: number;
	quality: number;
	lightingProfile: LightingProfileName;
	/** Accumulated item-definition transformation (inner matrix). */
	itemTransform?: Mat4;
	/** Tint colors by index (face tintindex / generated layer number). */
	tints?: Array<TintColor | null>;
	/** Needed for OBJ models, which read .obj/.mtl files from the asset tree. */
	resources?: ResourceManager;
}

export class ItemRenderError extends Error {}

export interface RenderedFrames {
	frames: FloatTexture[];
	/** Display duration per frame in milliseconds (50ms per game tick). */
	delaysMs: number[];
}

const TICK_MS = 50;
const MAX_ANIMATION_FRAMES = 128;

function gcd(left: number, right: number): number {
	return right === 0 ? left : gcd(right, left % right);
}

/**
 * Render every animation frame of a model (a single frame for unanimated
 * items). The tick loop mirrors upstream: total ticks = lcm of the involved
 * textures' lengths, identical frames are skipped, and interpolated textures
 * are capped at 128 emitted frames.
 */
export async function renderModelFrames(
	model: ResolvedModel,
	textures: TextureLoader,
	options: RenderOptions,
): Promise<RenderedFrames> {
	assertDrawable(model);
	if (model.obj || model.fluid) {
		// OBJ geometry and painted fluid buckets render a single static frame.
		return { frames: [await renderModel(model, textures, options)], delaysMs: [TICK_MS] };
	}
	// Collect the distinct texture references the model draws.
	const references = new Set<string>();
	if (model.builtinParent === 'builtin/generated') {
		for (const name of Object.keys(model.textures)) {
			if (/^layer\d+$/.test(name)) {
				references.add(`#${name}`);
			}
		}
	} else {
		for (const element of model.elements) {
			for (const face of Object.values(element.faces)) {
				if (face?.texture) {
					references.add(face.texture);
				}
			}
		}
	}

	const animated = new Map<string, AnimatedTexture>();
	const skipped = new Set<string>();
	for (const reference of references) {
		// Element faces bound to an unresolvable variable are skipped like the
		// game does; generated layers still fail loudly inside the render.
		if (model.builtinParent !== 'builtin/generated'
			&& reference.startsWith('#') && resolveTexture(model, reference) === null) {
			skipped.add(reference);
			continue;
		}
		animated.set(reference, await loadAnimatedTexture(model, textures, reference));
	}

	let ticks = 1;
	let interpolated = false;
	for (const texture of animated.values()) {
		ticks = ticks / gcd(ticks, texture.tickLength) * texture.tickLength;
		interpolated ||= texture.interpolated;
	}
	const maxSkippable = interpolated ? Math.ceil(ticks / MAX_ANIMATION_FRAMES) : null;

	const frames: FloatTexture[] = [];
	const emitTicks: number[] = [];
	let lastKey: string | null = null;
	let sinceLast = 0;
	for (let tick = 0; tick < ticks; tick++) {
		sinceLast++;
		const key = animated.values()
			.map(texture => texture.resolveFrame(tick).frame)
			.toArray()
			.join(',');
		if (lastKey !== null && key === lastKey && !interpolated && tick !== ticks - 1) {
			continue;
		}
		if (lastKey !== null && interpolated && maxSkippable !== null && sinceLast < maxSkippable && key === lastKey) {
			continue;
		}
		const supplier = async (reference: string): Promise<Texture | null> => {
			if (skipped.has(reference)) {
				return null;
			}
			const texture = animated.get(reference);
			if (!texture) {
				throw new ItemRenderError(`Untracked texture reference ${reference} in ${model.locator}`);
			}
			return texture.at(tick);
		};
		const renderSize = options.size * options.quality;
		const full = model.builtinParent === 'builtin/generated'
			? await renderGeneratedItemWith(model, supplier, renderSize, options.tints)
			: await renderElementModelWith(model, supplier, renderSize, options);
		frames.push(options.quality === 1 ? full : boxDownscale(full, options.quality));
		emitTicks.push(tick);
		lastKey = key;
		sinceLast = 0;
	}

	const delaysMs = emitTicks.map((tick, index) => {
		const next = index + 1 < emitTicks.length ? emitTicks[index + 1] : ticks;
		return Math.max(TICK_MS, (next - tick) * TICK_MS);
	});
	return { frames, delaysMs };
}

async function loadAnimatedTexture(
	model: ResolvedModel,
	textures: TextureLoader,
	reference: string,
): Promise<AnimatedTexture> {
	const locator = resolveTexture(model, reference);
	if (locator) {
		const texture = await textures.loadAnimated(locator);
		if (texture) {
			return texture;
		}
	}
	if (!reference.startsWith('#') && model.textures[reference] !== undefined) {
		const variable = resolveTexture(model, `#${reference}`);
		if (variable) {
			const texture = await textures.loadAnimated(variable);
			if (texture) {
				return texture;
			}
		}
	}
	throw new ItemRenderError(`Missing texture ${locator ?? reference} referenced by ${model.locator}`);
}

/**
 * Models with neither generated layers nor elements have no drawable geometry
 * (OBJ loaders, code-built block entities) — fail loudly rather than shipping
 * a transparent icon that still counts as "has an icon" downstream.
 */
function assertDrawable(model: ResolvedModel): void {
	if (model.obj) {
		return;
	}
	if (model.builtinParent !== null && model.builtinParent !== 'builtin/generated') {
		throw new ItemRenderError(`Unsupported builtin parent ${model.builtinParent} in ${model.locator}`);
	}
	if (model.builtinParent === null && model.elements.length === 0) {
		throw new ItemRenderError(`No drawable geometry in ${model.locator} (code-rendered model)`);
	}
	if (model.builtinParent === 'builtin/generated' && !Object.keys(model.textures).some(name => /^layer\d+$/.test(name))) {
		throw new ItemRenderError(`Generated model without layers in ${model.locator} (would render invisible)`);
	}
}

export async function renderModel(
	model: ResolvedModel,
	textures: TextureLoader,
	options: RenderOptions,
): Promise<FloatTexture> {
	assertDrawable(model);
	if (model.obj) {
		if (!options.resources) {
			throw new ItemRenderError(`OBJ model ${model.locator} needs RenderOptions.resources for file access`);
		}
		const full = await renderObjModel(model, options.resources, textures, options);
		return options.quality === 1 ? full : boxDownscale(full, options.quality);
	}
	const renderSize = options.size * options.quality;
	if (model.fluid && model.builtinParent === 'builtin/generated') {
		const filled = await renderFluidBucket(model, textures, renderSize, options.resources);
		if (filled) {
			return options.quality === 1 ? filled : boxDownscale(filled, options.quality);
		}
	}
	const full = model.builtinParent === 'builtin/generated'
		? await renderGeneratedItem(model, textures, renderSize, options.tints)
		: await renderElementModel(model, textures, renderSize, options);
	return options.quality === 1 ? full : boxDownscale(full, options.quality);
}

/**
 * fluid_container buckets: bucket sprite with the contained fluid painted into
 * the water-bucket fill region. Null when the fluid resolves to nothing, in
 * which case the plain bucket renders as before.
 */
async function renderFluidBucket(
	model: ResolvedModel,
	textures: TextureLoader,
	renderSize: number,
	resources?: ResourceManager,
): Promise<FloatTexture | null> {
	const locator = resolveTexture(model, '#layer0');
	const base = locator ? await textures.load(locator) : null;
	if (!base || !model.fluid) {
		return null;
	}
	const copy: Texture = { width: base.width, height: base.height, data: new Uint8ClampedArray(base.data) };
	if (!await paintBucketFluid(copy, model.fluid, textures, resources)) {
		return null;
	}
	return pointResize(toFloatTexture(copy), renderSize, renderSize);
}

async function loadTexture(
	model: ResolvedModel,
	textures: TextureLoader,
	reference: string,
): Promise<{ locator: ResourceLocator; texture: Texture; }> {
	const locator = resolveTexture(model, reference);
	if (locator) {
		const texture = await textures.load(locator);
		if (texture) {
			return { locator, texture };
		}
	}
	// Vanilla ships faces referencing variables without the # (heavy_core's
	// "texture": "all") — fall back to the variable when the direct path misses.
	if (!reference.startsWith('#') && model.textures[reference] !== undefined) {
		const variable = resolveTexture(model, `#${reference}`);
		if (variable) {
			const texture = await textures.load(variable);
			if (texture) {
				return { locator: variable, texture };
			}
		}
	}
	throw new ItemRenderError(`Missing texture ${locator ?? reference} referenced by ${model.locator}`);
}

/**
 * Flat generated item: numerically-sorted layerN textures, tinted by layer index,
 * point-upscaled to the render size, source-over composited. GUI display transforms
 * and lighting deliberately do not apply (upstream behavior).
 */
async function renderGeneratedItem(
	model: ResolvedModel,
	textures: TextureLoader,
	renderSize: number,
	tints?: Array<TintColor | null>,
): Promise<FloatTexture> {
	const supplier: TextureSupplier = async (reference) => {
		const loaded = await loadTexture(model, textures, reference);
		return loaded.texture;
	};
	return renderGeneratedItemWith(model, supplier, renderSize, tints);
}

/** Resolves a face's texture reference; null means "skip faces using it". */
type TextureSupplier = (reference: string) => Promise<Texture | null>;

async function renderGeneratedItemWith(
	model: ResolvedModel,
	supplier: TextureSupplier,
	renderSize: number,
	tints?: Array<TintColor | null>,
): Promise<FloatTexture> {
	const layerNames = Object.keys(model.textures)
		.map(name => /^layer(\d+)$/.exec(name))
		.filter((match): match is RegExpExecArray => match !== null)
		.toSorted((a, b) => Number(a[1]) - Number(b[1]));

	const out = new Float64Array(renderSize * renderSize * 4);
	for (const match of layerNames) {
		const layerIndex = Number(match[1]);
		const texture = await supplier(`#${match[0]}`);
		if (!texture) {
			// A generated item is nothing but its layers; a hole is a real failure.
			throw new ItemRenderError(`Missing texture #${match[0]} referenced by ${model.locator}`);
		}
		const float = toFloatTexture(texture);
		const tint = tints?.[layerIndex] ?? null;
		if (tint) {
			tintTexture(float, tint.r, tint.g, tint.b);
		}
		const resized = pointResize(float, renderSize, renderSize);
		for (let offset = 0; offset < out.length; offset += 4) {
			const alpha = resized.data[offset + 3];
			if (alpha > 0) {
				blendPixel(out, offset, resized.data[offset], resized.data[offset + 1], resized.data[offset + 2], alpha);
			}
		}
	}
	return { width: renderSize, height: renderSize, data: out };
}

async function renderElementModel(
	model: ResolvedModel,
	textures: TextureLoader,
	renderSize: number,
	options: RenderOptions,
): Promise<FloatTexture> {
	const supplier: TextureSupplier = async (reference) => {
		// An unresolvable variable (spectrum's literal "#missing") skips the
		// face, matching the game; a resolved path whose file is absent throws.
		if (reference.startsWith('#') && resolveTexture(model, reference) === null) {
			return null;
		}
		const loaded = await loadTexture(model, textures, reference);
		return loaded.texture;
	};
	return renderElementModelWith(model, supplier, renderSize, options);
}

async function renderElementModelWith(
	model: ResolvedModel,
	supplier: TextureSupplier,
	renderSize: number,
	options: RenderOptions,
): Promise<FloatTexture> {
	const lights = lightsForProfile(options.lightingProfile);
	const light = model.elementsGuiLight === 'side' ? lights.side : lights.front;

	const faces: RenderableFace[] = [];
	let skippedFaces = 0;
	for (const element of model.elements) {
		for (const geometry of buildElementFaces(element)) {
			const texture = await supplier(geometry.textureRef);
			if (!texture) {
				skippedFaces++;
				continue;
			}
			faces.push({
				geometry,
				texture: toFloatTexture(texture),
				light,
				tint: geometry.tintIndex !== null ? options.tints?.[geometry.tintIndex] ?? null : null,
				maxZ: faceMaxZ(geometry),
			});
		}
	}

	if (faces.length === 0 && skippedFaces > 0) {
		throw new ItemRenderError(`Every face texture unresolved in ${model.locator} (would render invisible)`);
	}

	// Ascending by untransformed model-space maxZ, stable — upstream's tie-break order.
	faces.sort((a, b) => a.maxZ - b.maxZ);

	const gui = model.display.gui;
	const guiMatrix = displayMatrix(
		(gui?.rotation ?? [0, 0, 0]) as Vec3,
		(gui?.translation ?? [0, 0, 0]) as Vec3,
		(gui?.scale ?? [1, 1, 1]) as Vec3,
	);
	const transformation = multiply(guiMatrix, options.itemTransform ?? identity());

	const buffers = [];
	for (const face of faces) {
		const buffer = renderFace(face, renderSize, renderSize, transformation);
		if (buffer) {
			buffers.push(buffer);
		}
	}
	return combineFaceBuffers(renderSize, renderSize, buffers);
}

/** Nearest-neighbour resize matching Imagick FILTER_POINT (destination-center sampling). */
export function pointResize(texture: FloatTexture, width: number, height: number): FloatTexture {
	const data = new Float64Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		let srcY = Math.floor((y + 0.5) * texture.height / height);
		srcY = srcY >= texture.height ? texture.height - 1 : srcY;
		for (let x = 0; x < width; x++) {
			let srcX = Math.floor((x + 0.5) * texture.width / width);
			srcX = srcX >= texture.width ? texture.width - 1 : srcX;
			const src = (srcY * texture.width + srcX) * 4;
			const dst = (y * width + x) * 4;
			data[dst] = texture.data[src];
			data[dst + 1] = texture.data[src + 1];
			data[dst + 2] = texture.data[src + 2];
			data[dst + 3] = texture.data[src + 3];
		}
	}
	return { width, height, data };
}

/**
 * Box downscale matching ImageMagick 6 ResizeImage with an alpha channel: two
 * passes (horizontal then vertical), each computing alpha-weighted colors
 * (color = Σ(aᵢ·cᵢ)/Σ(aᵢ), alpha = mean) and storing every intermediate as a
 * Q16 quantum with round-half-up. Verified against Imagick FILTER_BOX output.
 */
export function boxDownscale(texture: FloatTexture, factor: number): FloatTexture {
	const horizontal = boxPass(texture, factor, true);
	return boxPass(horizontal, factor, false);
}

function boxPass(texture: FloatTexture, factor: number, isHorizontal: boolean): FloatTexture {
	const width = isHorizontal ? Math.round(texture.width / factor) : texture.width;
	const height = isHorizontal ? texture.height : Math.round(texture.height / factor);
	const data = new Float64Array(width * height * 4);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			// Accumulate in integer quantum space: normalized floats drift by an
			// ulp across /65535 round trips, flipping .5 cases the wrong way.
			let r = 0;
			let g = 0;
			let b = 0;
			let alphaSum = 0;
			for (let i = 0; i < factor; i++) {
				const srcX = isHorizontal ? x * factor + i : x;
				const srcY = isHorizontal ? y : y * factor + i;
				const src = (srcY * texture.width + srcX) * 4;
				const alpha = Math.round(texture.data[src + 3] * 65535);
				r += Math.round(texture.data[src] * 65535) * alpha;
				g += Math.round(texture.data[src + 1] * 65535) * alpha;
				b += Math.round(texture.data[src + 2] * 65535) * alpha;
				alphaSum += alpha;
			}
			const dst = (y * width + x) * 4;
			if (alphaSum > 0) {
				data[dst] = clampQuantum(r / alphaSum) / 65535;
				data[dst + 1] = clampQuantum(g / alphaSum) / 65535;
				data[dst + 2] = clampQuantum(b / alphaSum) / 65535;
			}
			data[dst + 3] = clampQuantum(alphaSum / factor) / 65535;
		}
	}
	return { width, height, data };
}

/** ClampToQuantum on a value already in quantum units: floor(x + 0.5), clamped. */
function clampQuantum(quantum: number): number {
	const rounded = Math.floor(quantum + 0.5);
	return rounded < 0 ? 0 : (Math.min(rounded, 65535));
}
