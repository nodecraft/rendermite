/**
 * The one piece of `light.json` a consumer evaluates at runtime: which case a placed block's state
 * falls under. Kept apart from the exporter, like `blockstate-eval.ts`, so a browser can import it
 * without the toolchain.
 */

import type { BlockProperties } from './blockstate-eval.ts';
import type { BlockPackLight } from './pack-format.ts';

/**
 * The light a block emits in the given state, 0–15.
 *
 * A case applies when every property it names has that value on the state; the first that does wins,
 * and `default` answers for the rest. A block absent from `light.json` emits nothing, so `undefined`
 * is a valid entry and answers 0.
 */
export function blockLightLevel(light: BlockPackLight | undefined, properties: BlockProperties | undefined): number {
	if (light === undefined) {
		return 0;
	}
	if (typeof light === 'number') {
		return light;
	}
	for (const entry of light.cases) {
		let matches = true;
		for (const [name, value] of Object.entries(entry.when)) {
			if (properties?.[name] !== value) {
				matches = false;
				break;
			}
		}
		if (matches) {
			return entry.level;
		}
	}
	return light.default;
}
