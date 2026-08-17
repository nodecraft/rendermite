/**
 * A Minecraft resource locator (`namespace:path`, e.g. `minecraft:item/stone`).
 *
 * Mirrors vanilla semantics: the namespace defaults to `minecraft` when omitted, and both
 * halves are restricted to the character sets the game itself enforces. Mods regularly ship
 * ids the game would reject (uppercase, spaces); we normalize case rather than fail, because
 * a rejected id means a missing icon for an item that renders fine in game.
 */

const NAMESPACE_PATTERN = /^[\d._a-z-]+$/;
const PATH_PATTERN = /^[\d./_a-z-]+$/;

export class InvalidResourceLocatorError extends Error {}

/**
 * Collapse `.` and `..` segments, or null when the path climbs out of the pack.
 * Ids come from jars, OBJ `mtllib` lines and MTL texture bindings, and every one
 * of them is joined onto an asset root on disk, so an escaping path reads a file
 * the pack does not contain.
 */
function containedPath(path: string): string | null {
	if (!path.includes('.')) {
		return path;
	}
	const segments: string[] = [];
	for (const segment of path.split('/')) {
		if (segment === '.') {
			continue;
		}
		if (segment !== '..') {
			segments.push(segment);
			continue;
		}
		if (segments.length === 0) {
			return null;
		}
		segments.pop();
	}
	return segments.join('/');
}

export class ResourceLocator {
	static parse(locator: string, defaultNamespace = 'minecraft'): ResourceLocator {
		const colon = locator.indexOf(':');
		let namespace = defaultNamespace;
		let path = locator;
		if (colon !== -1) {
			namespace = locator.slice(0, colon) || defaultNamespace;
			path = locator.slice(colon + 1);
		}

		// Mods ship uppercase/whitespace ids the game itself would reject; normalize instead
		// of failing so those items still get icons.
		namespace = namespace.trim().toLowerCase();
		path = path.trim().toLowerCase();

		if (!NAMESPACE_PATTERN.test(namespace)) {
			throw new InvalidResourceLocatorError(`Invalid namespace in resource locator: ${locator}`);
		}
		if (!PATH_PATTERN.test(path)) {
			throw new InvalidResourceLocatorError(`Invalid path in resource locator: ${locator}`);
		}
		const contained = containedPath(path);
		if (contained === null || contained.length === 0) {
			throw new InvalidResourceLocatorError(`Path does not resolve inside the pack: ${locator}`);
		}
		return new ResourceLocator(namespace, contained);
	}

	/** Parse, returning null instead of throwing for ids too malformed to normalize. */
	static tryParse(locator: string, defaultNamespace = 'minecraft'): ResourceLocator | null {
		try {
			return this.parse(locator, defaultNamespace);
		} catch {
			return null;
		}
	}

	readonly namespace: string;
	readonly path: string;

	constructor(namespace: string, path: string) {
		this.namespace = namespace;
		this.path = path;
	}

	toString(): string {
		return `${this.namespace}:${this.path}`;
	}

	equals(other: ResourceLocator): boolean {
		return this.namespace === other.namespace && this.path === other.path;
	}

	/** New locator with the path prefixed (e.g. `prefix('models') + '.json'` for disk lookup). */
	withPath(path: string): ResourceLocator {
		return new ResourceLocator(this.namespace, path);
	}
}
