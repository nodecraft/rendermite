/**
 * Laying an accent sheet over the sheet it decorates.
 *
 * Some mods draw one thing from two textures: Sophisticated Storage's gold
 * chest is `entity/chest/oak` with `entity/chest/gold_tier` composited on top,
 * and its block entity renderer does that at draw time. A pipeline that reads
 * assets only ever picks one of the two, and picking the trim leaves a chest
 * that is 95% transparent — the tier sheet covers 5% of its pixels.
 *
 * The composed sheet is registered with the texture loader rather than written
 * anywhere: both consumers address textures by locator, and the accent pairing
 * is a property of this run's asset tree, not of any jar.
 */

import { ResourceLocator } from '../resources/locator.ts';

import type { Texture, TextureLoader } from './loader.ts';

/** Where a composed sheet is addressed from; never a path a jar can ship. */
const OVERLAY_NAMESPACE = 'rendermite';

/** Source-over composite, in place on a copy of the base. */
function sourceOver(base: Texture, accent: Texture): Texture {
	const data = new Uint8ClampedArray(base.data);
	for (let offset = 0; offset < data.length; offset += 4) {
		const alpha = accent.data[offset + 3] / 255;
		if (alpha === 0) {
			continue;
		}
		for (let channel = 0; channel < 3; channel++) {
			data[offset + channel] = accent.data[offset + channel] * alpha + data[offset + channel] * (1 - alpha);
		}
		data[offset + 3] = (alpha + (data[offset + 3] / 255) * (1 - alpha)) * 255;
	}
	return { width: base.width, height: base.height, data };
}

/**
 * Compose `accent` over `base` and return the locator the result is registered
 * under, or null when either sheet is missing or they are different sizes —
 * two layouts cannot be layered pixel for pixel, and stretching one would
 * smear a trim across faces it does not belong to.
 */
export async function overlaySheets(
	textures: TextureLoader,
	base: ResourceLocator,
	accent: ResourceLocator,
): Promise<ResourceLocator | null> {
	const composed = new ResourceLocator(
		OVERLAY_NAMESPACE,
		`overlay/${base.namespace}/${accent.path.replaceAll('/', '_')}_over_${base.path.replaceAll('/', '_')}`,
	);
	if (await textures.has(composed)) {
		return composed;
	}
	const [baseTexture, accentTexture] = await Promise.all([
		textures.load(base).catch(() => null),
		textures.load(accent).catch(() => null),
	]);
	if (!baseTexture || !accentTexture) {
		return null;
	}
	if (baseTexture.width !== accentTexture.width || baseTexture.height !== accentTexture.height) {
		return null;
	}
	textures.register(composed, sourceOver(baseTexture, accentTexture));
	return composed;
}
