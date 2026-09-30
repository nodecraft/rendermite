/**
 * Every block's full property set and default state, from Minecraft's own data generator.
 *
 * `blockstates.json` only names the properties that change a model, so it cannot say that stairs are
 * `waterlogged`, or which value a freshly placed block takes. The generator's `blocks.json` report
 * lists every property with its values in the game's order, and marks the default state. Nothing in
 * the client jar says either, so the report is read when the caller has one (`--reports`); the
 * generator needs a JDK, which this package deliberately does not.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** One block's properties: each name with its values in the game's order, and the default state. */
export interface BlockStateSpec {
	/** Absent for a block with no properties, which is most of them. */
	properties?: Record<string, string[]>;
	default?: Record<string, string>;
}

/** `states.json`: block id → its properties and default state. */
export type BlockStatesPack = Record<string, BlockStateSpec>;

interface BlocksReport {
	[id: string]: {
		properties?: Record<string, string[]>;
		states?: Array<{ default?: boolean; properties?: Record<string, string>; }>;
	};
}

/**
 * Reads `blocks.json` out of a generator `reports` directory, or null when there is none there: a
 * caller with no reports gets a pack without `states.json` rather than a failed export.
 */
export async function readBlockStates(reportsDir: string): Promise<BlockStatesPack | null> {
	let report: BlocksReport;
	try {
		report = JSON.parse(await readFile(path.join(reportsDir, 'blocks.json'), 'utf8')) as BlocksReport;
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw err;
	}
	const pack: BlockStatesPack = {};
	for (const [id, block] of Object.entries(report)) {
		if (!block.properties || Object.keys(block.properties).length === 0) {
			pack[id] = {};
			continue;
		}
		const defaultState = block.states?.find(state => state.default) ?? block.states?.[0];
		pack[id] = { properties: block.properties, default: defaultState?.properties ?? {} };
	}
	return pack;
}
