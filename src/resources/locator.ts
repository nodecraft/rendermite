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
		return new ResourceLocator(namespace, path);
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
