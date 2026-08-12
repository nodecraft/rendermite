import { transform } from 'lightningcss';

// Version numbers are 16.16 fixed-point (major << 16 | minor << 8). Floors sit
// around the last few major releases of each engine — everything here supports
// unprefixed mask-*, so the emitted sheet carries no vendor fallbacks.
const TARGETS = {
	chrome: 137 << 16,
	edge: 137 << 16,
	firefox: 138 << 16,
	safari: 18 << 16,
};

/**
 * Minify a stylesheet with lightningcss. On a parse failure the readable sheet
 * is returned unchanged and reported — mods have shipped item names that break
 * whole stylesheets, and losing every icon to one bad rule is the old
 * pipeline's failure mode, not ours (our selectors are sanitized upstream of
 * this, so failures here should be exceptional).
 */
export function minifyStylesheet(css: string, onWarning?: (message: string) => void): string {
	try {
		const result = transform({
			filename: 'icons.css',
			code: Buffer.from(css, 'utf8'),
			minify: true,
			targets: TARGETS,
		});
		return Buffer.from(result.code).toString('utf8');
	} catch (err) {
		onWarning?.(`Stylesheet minification failed, emitting unminified: ${(err as Error).message}`);
		return css;
	}
}
