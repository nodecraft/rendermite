/**
 * Geometry for mod items the game draws in code. A `builtin/entity` item model
 * carries display transforms and nothing else — the boxes live in a Java class,
 * so no fallback in the chain can find them and the item fails outright.
 *
 * `assets/mod-models/` ports that geometry to ordinary element models, keyed by
 * the model path the mod's own item already resolves to. Hand-authored per item
 * and layered ABOVE the mod jars, so it shadows the `builtin/entity` stub in
 * every era (see assets/mod-models/README.md for per-item provenance).
 */

import { modModelPackPath } from '../builtin.ts';
import { FolderResourceManager } from '../resources/manager.ts';

import type { ResourceManager } from '../resources/manager.ts';

export function curatedModelOverrides(): ResourceManager {
	return new FolderResourceManager(modModelPackPath());
}
