/**
 * Stylesheet generation matching the renderchest CSS contract
 * (docs/css-output.md). Differences by design: selectors are
 * sanitized (junk mod item names once broke whole sheets), and the URL prefix
 * is configurable so published sheets need no downstream rebasing.
 */

export interface StylesheetOptions {
	/** CSS class prefix, default `rc-`. */
	prefix?: string;
	/** Prepended to every url(); default '' = relative to the stylesheet. */
	urlPrefix?: string;
	/** Primary image format for the upgrade block; base rules always use png. */
	format?: 'webp' | 'avif';
	/** Emit the base rules in png plus a media-query upgrade block. */
	fallback?: boolean;
	/** Emit the enchant glint overlay (default true); off when there is no glint image to point it at. */
	glint?: boolean;
}

export interface ItemStyle {
	/** Item id, e.g. `minecraft:stone`. */
	id: string;
	/** Image path relative to output root, without extension (e.g. `items/minecraft/stone`). */
	image: string;
	/** Custom properties set on the base rule (e.g. --rc-layer-1-tint: #9e643f). */
	variables?: Record<string, string>;
	/** Mask image path (defaults to none — cleared for regular items). */
	mask?: string | null;
	/** :before layer image, for two-layer items. */
	before?: { image: string; mask?: string; };
	/**
	 * Extra selector-suffixed variants: `before` styles the pseudo-element
	 * (trims, pot overlays); `image`/`mask` restyle the base element
	 * (pot bodies, crossbow projectiles).
	 */
	variants?: Array<{
		suffix: string;
		image?: string;
		mask?: string;
		before?: { image: string; mask?: string; };
	}>;
	/** Item always shows the enchant glint (enchanted book etc.). */
	alwaysEnchanted?: boolean;
}

/** Class-name sanitization is a security/robustness boundary: ids come from mod jars. */
export function itemClass(id: string, prefix = 'rc-'): string {
	return prefix + id.replaceAll(':', '_').replaceAll(/[^\w.-]/g, '_').replaceAll('.', String.raw`\.`);
}

function url(path: string, urlPrefix: string): string {
	return `url('${urlPrefix}${path}')`;
}

export function generateStylesheet(items: ItemStyle[], options: StylesheetOptions = {}): string {
	const prefix = options.prefix ?? 'rc-';
	const urlPrefix = options.urlPrefix ?? '';
	const format = options.format ?? 'webp';
	const fallback = options.fallback ?? true;
	const baseExtension = fallback ? 'png' : format;

	const blocks: string[] = [];
	const upgrade: string[] = [];
	const enchantedSelectors: string[] = [];

	const itemSelector = `.${prefix}item`;
	const unknown = 'items/renderchest/unknown';
	const empty = 'items/renderchest/empty';

	// Base rules mirror upstream's DefaultItemStyleGenerator globals. The glint slides an oversized
	// layer instead of scrolling background-position, so it runs on the compositor, not repainting.
	blocks.push(
		`@keyframes ${prefix}enchanted {\n    from { transform: rotate(-8deg) translate(0, 0); }\n    to { transform: rotate(-8deg) translate(512px, -2048px); }\n}`,
		`${itemSelector} {\n    position: relative;\n    image-rendering: pixelated;\n    background-image: ${url(`${unknown}.${baseExtension}`, urlPrefix)};\n    mask-image: ${url(`${unknown}.${baseExtension}`, urlPrefix)};\n    background-size: cover;\n    background-color: var(--${prefix}layer-1-tint);\n    background-blend-mode: multiply;\n    mask-size: cover;\n}`,
		`${itemSelector}.${prefix}enchanted {\n    mask-image: ${url(`${unknown}.${baseExtension}`, urlPrefix)};\n}`,
		`${itemSelector}:before {\n    content: '';\n    position: absolute;\n    width: 100%;\n    height: 100%;\n    top: 0;\n    left: 0;\n    image-rendering: pixelated;\n    background-image: ${url(`${empty}.${baseExtension}`, urlPrefix)};\n    background-size: cover;\n    background-color: var(--${prefix}layer-2-tint);\n    background-blend-mode: multiply;\n    mask-size: cover;\n}`,
	);
	upgrade.push(
		`${itemSelector} { background-image: ${url(`${unknown}.${format}`, urlPrefix)}; mask-image: ${url(`${unknown}.${format}`, urlPrefix)}; }`,
		`${itemSelector}:before { background-image: ${url(`${empty}.${format}`, urlPrefix)}; }`,
	);

	for (const item of items) {
		const selector = `${itemSelector}.${itemClass(item.id, prefix)}`;
		const image = (ext: string) => url(`${item.image}.${ext}`, urlPrefix);

		const baseProps: string[] = [];
		for (const [name, value] of Object.entries(item.variables ?? {})) {
			baseProps.push(`${name}: ${value};`);
		}
		baseProps.push(`background-image: ${image(baseExtension)};`);
		const mask = item.mask === undefined ? null : item.mask;
		if (item.alwaysEnchanted) {
			enchantedSelectors.push(`${selector}:after`);
			baseProps.push(`mask-image: ${image(baseExtension)};`);
		} else if (mask === null) {
			baseProps.push('mask-image: none;');
		} else {
			baseProps.push(`mask-image: ${url(`${mask}.${baseExtension}`, urlPrefix)};`);
		}
		blocks.push(`${selector} {\n    ${baseProps.join('\n    ')}\n}`);
		blocks.push(`${selector}.${prefix}enchanted {\n    mask-image: ${image(baseExtension)};\n}`);
		upgrade.push(`${selector} { background-image: ${image(format)}; ${mask !== null || item.alwaysEnchanted ? `mask-image: ${url(`${mask ?? item.image}.${format}`, urlPrefix)}; ` : ''}}`);
		upgrade.push(`${selector}.${prefix}enchanted { mask-image: ${image(format)}; }`);

		if (item.before) {
			const beforeProps = [
				`background-image: ${url(`${item.before.image}.${baseExtension}`, urlPrefix)};`,
			];
			if (item.before.mask) {
				beforeProps.push(`mask-image: ${url(`${item.before.mask}.${baseExtension}`, urlPrefix)};`);
			}
			blocks.push(`${selector}:before {\n    ${beforeProps.join('\n    ')}\n}`);
			upgrade.push(`${selector}:before { background-image: ${url(`${item.before.image}.${format}`, urlPrefix)}; }`);
		}

		for (const variant of item.variants ?? []) {
			if (variant.image) {
				const variantSelector = `${selector}.${prefix}${variant.suffix}`;
				const props = [`background-image: ${url(`${variant.image}.${baseExtension}`, urlPrefix)};`];
				if (variant.mask) {
					props.push(`mask-image: ${url(`${variant.mask}.${baseExtension}`, urlPrefix)};`);
				}
				blocks.push(`${variantSelector} {\n    ${props.join('\n    ')}\n}`);
				blocks.push(`${variantSelector}.${prefix}enchanted {\n    mask-image: ${url(`${variant.image}.${baseExtension}`, urlPrefix)};\n}`);
				upgrade.push(`${variantSelector} { background-image: ${url(`${variant.image}.${format}`, urlPrefix)}; }`);
			}
			if (!variant.before) {
				continue;
			}
			const variantSelector = `${selector}.${prefix}${variant.suffix}:before`;
			const props = [`background-image: ${url(`${variant.before.image}.${baseExtension}`, urlPrefix)};`];
			if (variant.before.mask) {
				props.push(`mask-image: ${url(`${variant.before.mask}.${baseExtension}`, urlPrefix)};`);
			}
			blocks.push(`${variantSelector} {\n    ${props.join('\n    ')}\n}`);
			upgrade.push(`${variantSelector} { background-image: ${url(`${variant.before.image}.${format}`, urlPrefix)}; }`);
		}
	}

	// Glint rule last (upstream's global post styles), unioned with always-enchanted items.
	if (options.glint ?? true) {
		const glintSelectors = [...enchantedSelectors, `.${prefix}enchanted:after`];
		const glint = `${glintSelectors.join(',\n')} {\n    position: absolute;\n    width: calc(200% + 512px);\n    height: calc(200% + 2048px);\n    top: -50%;\n    left: calc(-50% - 512px);\n    image-rendering: pixelated;\n    mix-blend-mode: screen;\n    content: '';\n    opacity: 0.6;\n    background-image: ${url(`${prefix}enchantment.${baseExtension}`, urlPrefix)};\n    background-size: 512px 512px;\n    background-position: 256px 0;\n    filter: blur(2px) contrast(200%);\n    transform-origin: calc(50% + 256px) calc(50% - 1024px);\n    transform: rotate(-8deg);\n    animation-name: ${prefix}enchanted;\n    animation-duration: 32s;\n    animation-timing-function: linear;\n    animation-iteration-count: infinite;\n}`;
		blocks.push(glint);
		upgrade.push(`${glintSelectors.join(', ')} { background-image: ${url(`${prefix}enchantment.${format}`, urlPrefix)}; }`);
	}

	if (fallback) {
		blocks.push(`@media (min-resolution: 1dpi) {\n${upgrade.map(rule => `    ${rule}`).join('\n')}\n}`);
	}

	return blocks.join('\n\n');
}
