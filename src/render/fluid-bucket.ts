/**
 * Paint bucket contents for fluid_container loader models. Forge draws these
 * with a fluid sprite behind a mask texture we don't ship, but vanilla always
 * has both `bucket` and `water_bucket` sprites — their pixel diff IS the fill
 * region, and the fluid's average color (from its conventional still texture)
 * shaded by the water sprite's own shading paints it convincingly.
 */

import { ResourceLocator } from '../resources/locator.ts';

import type { ResourceManager } from '../resources/manager.ts';
import type { Texture, TextureLoader } from '../textures/loader.ts';

/** Conventional homes for a fluid's still texture, most common first. */
const STILL_TEXTURE_PATTERNS = [
	(name: string) => `block/fluid/${name}_still`,
	(name: string) => `block/${name}_still`,
	(name: string) => `fluid/${name}_still`,
	(name: string) => `block/fluid/${name}`,
	(name: string) => `blocks/fluids/${name}_still`,
	(name: string) => `blocks/${name}_still`,
];

/** The particle texture declared by the fluid's block model, if any. */
async function particleTexture(
	fluid: ResourceLocator,
	textures: TextureLoader,
	resources: ResourceManager,
): Promise<Texture | null> {
	const raw = await resources.getResource('model', new ResourceLocator(fluid.namespace, `block/${fluid.path}`));
	if (!raw) {
		return null;
	}
	try {
		const particle = (JSON.parse(raw.toString('utf8')) as { textures?: { particle?: string; }; }).textures?.particle;
		const locator = typeof particle === 'string' && !particle.startsWith('#') ? ResourceLocator.tryParse(particle) : null;
		return locator ? await textures.load(locator) : null;
	} catch {
		return null;
	}
}

/** Average color of a texture's opaque pixels, or null if fully transparent. */
function averageColor(texture: Texture): [number, number, number] | null {
	let red = 0;
	let green = 0;
	let blue = 0;
	let count = 0;
	for (let offset = 0; offset < texture.data.length; offset += 4) {
		if (texture.data[offset + 3] <= 128) {
			continue;
		}

		red += texture.data[offset];
		green += texture.data[offset + 1];
		blue += texture.data[offset + 2];
		count++;
	}
	return count === 0 ? null : [red / count, green / count, blue / count];
}

/**
 * Paint the fluid into a bucket sprite IN PLACE (pass a copy, never a cached
 * texture) at native sprite resolution. The unpainted sprite doubles as the
 * empty-bucket reference: fill pixels are where water_bucket is opaque and the
 * bucket is not, and each pixel's condition reads state that painting never
 * touches. Returns false when the fluid can't be resolved — the plain bucket
 * stays, which is the old behavior.
 */
export async function paintBucketFluid(
	bucket: Texture,
	fluid: string,
	textures: TextureLoader,
	resources?: ResourceManager,
): Promise<boolean> {
	const fluidLocator = ResourceLocator.tryParse(fluid);
	if (!fluidLocator) {
		return false;
	}
	let still: Texture | null = null;
	for (const pattern of STILL_TEXTURE_PATTERNS) {
		still = await textures.load(new ResourceLocator(fluidLocator.namespace, pattern(fluidLocator.path)));
		if (still) {
			break;
		}
	}
	// Last resort: the fluid's own block model declares its particle texture
	// (mekanism's fluids all point at a shared code-tinted sheet this way).
	still ??= resources ? await particleTexture(fluidLocator, textures, resources) : null;
	const color = still ? averageColor(still) : null;
	if (!color) {
		return false;
	}

	const water = await textures.load(ResourceLocator.parse('minecraft:item/water_bucket'));
	if (!water || water.width !== bucket.width || water.height !== bucket.height) {
		return false;
	}

	// Water-region shading is preserved by scaling the fluid color per pixel
	// against the region's peak luminance, so highlights survive recoloring.
	const luminance = (offset: number) => 0.299 * water.data[offset] + 0.587 * water.data[offset + 1] + 0.114 * water.data[offset + 2];
	// The empty bucket draws its back rim where the water sits, so the fill
	// region is where the sprites DIFFER, not just where alpha appears.
	const isFill = (offset: number) => water.data[offset + 3] > 128 && (
		bucket.data[offset + 3] <= 128
		|| Math.abs(water.data[offset] - bucket.data[offset])
		+ Math.abs(water.data[offset + 1] - bucket.data[offset + 1])
		+ Math.abs(water.data[offset + 2] - bucket.data[offset + 2]) > 60
	);
	let peakLuma = 1;
	for (let offset = 0; offset < water.data.length; offset += 4) {
		if (isFill(offset)) {
			peakLuma = Math.max(peakLuma, luminance(offset));
		}
	}
	let painted = false;
	for (let offset = 0; offset < water.data.length; offset += 4) {
		if (!isFill(offset)) {
			continue;
		}

		const shade = luminance(offset) / peakLuma;
		bucket.data[offset] = Math.min(255, color[0] * shade);
		bucket.data[offset + 1] = Math.min(255, color[1] * shade);
		bucket.data[offset + 2] = Math.min(255, color[2] * shade);
		bucket.data[offset + 3] = 255;
		painted = true;
	}
	return painted;
}
