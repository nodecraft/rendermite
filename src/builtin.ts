import path from 'node:path';

/**
 * Paths to the vendored builtin packs (see assets/README.md). Resolved
 * relative to this package so library consumers and tests never hardcode
 * machine-specific locations.
 */

const assetsRoot = path.join(import.meta.dirname, '..', 'assets');

export function builtinPackPath(era: 'modern' | 'legacy'): string {
	return path.join(assetsRoot, era === 'modern' ? 'builtin' : 'builtin-legacy');
}

export function bedCompatPath(): string {
	return path.join(assetsRoot, 'builtin-bed-compat');
}
