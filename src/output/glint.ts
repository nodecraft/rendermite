/**
 * Pre-bakes the enchant glint's blur and contrast into its texture, so the
 * stylesheet can scroll a plain image instead of running a filter on every
 * glinting item every frame.
 */

import sharp from 'sharp';

/** The glint rule's background-size, so the browser draws the baked tile without rescaling it. */
const GLINT_TILE = 512;
/** Upstream's `blur(2px)`. */
const BLUR_SIGMA = 2;
/** Well past 3 sigma, so blurring across the wrapped edges leaves no seam. */
const WRAP_PADDING = 16;

/**
 * Upscale the glint to its tile size, blur it as a repeating tile, then apply
 * upstream's `contrast(200%)`. Both filters commute with the glint's rotation
 * and scroll, so baking them here draws the same pixels the CSS filter did.
 */
export async function bakeGlint(texture: Buffer): Promise<Buffer> {
	const tile = await sharp(texture)
		.ensureAlpha()
		.resize(GLINT_TILE, GLINT_TILE, { kernel: 'nearest' })
		.png()
		.toBuffer();
	// sharp runs operations in a fixed order rather than call order, so each step is its own pipeline.
	const blurred = await sharp(tile)
		.extend({ top: WRAP_PADDING, bottom: WRAP_PADDING, left: WRAP_PADDING, right: WRAP_PADDING, extendWith: 'repeat' })
		.blur(BLUR_SIGMA)
		.png()
		.toBuffer();
	return sharp(blurred)
		.extract({ left: WRAP_PADDING, top: WRAP_PADDING, width: GLINT_TILE, height: GLINT_TILE })
		.linear([2, 2, 2, 1], [-127.5, -127.5, -127.5, 0])
		.png()
		.toBuffer();
}
