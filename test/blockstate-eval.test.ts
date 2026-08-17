/**
 * Blockstate evaluation for the block pack: the real thing, as opposed to the
 * icon path's default-variant guess. This is where the bugs live, so the
 * predicate forms are covered against hand-written JSON.
 */

import { describe, expect, it } from 'vitest';

import {
	BlockStateError,
	collectModels,
	evaluateBlockState,
	parseBlockState,
	weightedVariantIndex,
} from '../src/blocks/blockstate-eval.ts';

import type { BlockStateDefinition } from '../src/blocks/blockstate-eval.ts';

const parse = (json: unknown, namespace = 'minecraft') => parseBlockState(namespace, json);

/** Flatten a match down to the model ids it draws, in order. */
function drawn(json: unknown, properties: Record<string, string>, namespace = 'minecraft'): string[] {
	return drawnWith(parse(json, namespace), properties);
}

function drawnWith(definition: BlockStateDefinition, properties: Record<string, string>): string[] {
	return evaluateBlockState(definition, properties).flatMap(list => list.map(entry => entry.model));
}

describe('variants', () => {
	it('matches an exact property key', () => {
		const json = {
			variants: {
				'facing=north,half=bottom': { model: 'minecraft:block/oak_stairs' },
				'facing=south,half=bottom': { model: 'minecraft:block/oak_stairs', y: 180 },
			},
		};
		expect(drawn(json, { facing: 'south', half: 'bottom', shape: 'straight' }))
			.toEqual(['minecraft:block/oak_stairs']);
		expect(evaluateBlockState(parse(json), { facing: 'south', half: 'bottom' })[0][0].y).toBe(180);
	});

	it('treats an empty key as matching everything', () => {
		const json = { variants: { '': { model: 'minecraft:block/stone' } } };
		expect(drawn(json, {})).toEqual(['minecraft:block/stone']);
		expect(drawn(json, { anything: 'at_all' })).toEqual(['minecraft:block/stone']);
	});

	it('leaves unstated properties as wildcards', () => {
		// The key constrains `axis` only; `waterlogged` must not stop it matching.
		const json = { variants: { 'axis=y': { model: 'minecraft:block/oak_log' } } };
		expect(drawn(json, { axis: 'y', waterlogged: 'false' })).toEqual(['minecraft:block/oak_log']);
		expect(drawn(json, { axis: 'x' })).toEqual([]);
	});

	it('prefers the most constrained key when several match', () => {
		const json = {
			variants: {
				'facing=north': { model: 'example:block/loose' },
				'facing=north,open=true': { model: 'example:block/tight' },
			},
		};
		expect(drawn(json, { facing: 'north', open: 'true' }, 'example')).toEqual(['example:block/tight']);
	});

	it('carries x, y, uvlock and weight through', () => {
		const json = {
			variants: {
				'': [
					{ model: 'minecraft:block/grass_block', weight: 3 },
					{ model: 'minecraft:block/grass_block', y: 90, uvlock: true, x: 180 },
				],
			},
		};
		const [list] = evaluateBlockState(parse(json), {});
		expect(list).toEqual([
			{ model: 'minecraft:block/grass_block', x: 0, y: 0, z: 0, uvlock: false, weight: 3 },
			{ model: 'minecraft:block/grass_block', x: 180, y: 90, z: 0, uvlock: true, weight: 1 },
		]);
	});

	it('reads a namespaced z rotation, which vanilla has no equivalent for', () => {
		// AE2 spins wall-mounted blocks about their facing axis with `ae2:z`.
		const json = { variants: { 'facing=down,spin=1': { 'model': 'ae2:block/charger', 'x': 90, 'ae2:z': 270 } } };
		const [list] = evaluateBlockState(parse(json, 'ae2'), { facing: 'down', spin: '1' });
		expect(list[0]).toMatchObject({ model: 'ae2:block/charger', x: 90, z: 270 });
	});

	it('emits the whole weighted list rather than taking the first', () => {
		const json = {
			variants: {
				'': [
					{ model: 'minecraft:block/dirt' },
					{ model: 'minecraft:block/dirt', y: 90 },
					{ model: 'minecraft:block/dirt', y: 180 },
				],
			},
		};
		expect(evaluateBlockState(parse(json), {})[0]).toHaveLength(3);
	});

	it('drops a variant the game can never pick', () => {
		const json = {
			variants: {
				'': [
					{ model: 'example:block/never', weight: 0 },
					{ model: 'example:block/always', weight: 5 },
				],
			},
		};
		expect(drawn(json, {}, 'example')).toEqual(['example:block/always']);
		expect(() => parse({ variants: { '': [{ model: 'example:block/never', weight: 0 }] } }, 'example'))
			.toThrow(BlockStateError);
	});

	it('resolves an unqualified model against the block namespace', () => {
		const json = { variants: { '': { model: 'block/widget' } } };
		expect(drawn(json, {}, 'example')).toEqual(['example:block/widget']);
	});
});

describe('multipart', () => {
	const fence = {
		multipart: [
			{ apply: { model: 'minecraft:block/oak_fence_post' } },
			{ when: { north: 'true' }, apply: { model: 'minecraft:block/oak_fence_side' } },
			{ when: { east: 'true' }, apply: { model: 'minecraft:block/oak_fence_side', y: 90 } },
		],
	};

	it('applies every matching part, not just the first', () => {
		expect(drawn(fence, { north: 'true', east: 'true', south: 'false', west: 'false' })).toEqual([
			'minecraft:block/oak_fence_post',
			'minecraft:block/oak_fence_side',
			'minecraft:block/oak_fence_side',
		]);
	});

	it('always applies an unconditional part', () => {
		expect(drawn(fence, { north: 'false', east: 'false' })).toEqual(['minecraft:block/oak_fence_post']);
	});

	it('matches any of an a|b|c alternate', () => {
		const json = {
			multipart: [{ when: { shape: 'north_west|north_east|south_east' }, apply: { model: 'example:block/corner' } }],
		};
		expect(drawn(json, { shape: 'north_east' }, 'example')).toEqual(['example:block/corner']);
		expect(drawn(json, { shape: 'straight' }, 'example')).toEqual([]);
	});

	it('evaluates OR', () => {
		const json = {
			multipart: [{
				when: { OR: [{ north: 'true' }, { south: 'true' }] },
				apply: { model: 'example:block/bar' },
			}],
		};
		expect(drawn(json, { north: 'false', south: 'true' }, 'example')).toEqual(['example:block/bar']);
		expect(drawn(json, { north: 'false', south: 'false' }, 'example')).toEqual([]);
	});

	it('evaluates AND', () => {
		const json = {
			multipart: [{
				when: { AND: [{ up: 'true' }, { OR: [{ north: 'true' }, { east: 'true' }] }] },
				apply: { model: 'example:block/cap' },
			}],
		};
		expect(drawn(json, { up: 'true', north: 'false', east: 'true' }, 'example')).toEqual(['example:block/cap']);
		expect(drawn(json, { up: 'false', north: 'true', east: 'true' }, 'example')).toEqual([]);
	});

	it('requires every property of a flat when', () => {
		const json = { multipart: [{ when: { up: 'true', down: 'true' }, apply: { model: 'example:block/both' } }] };
		expect(drawn(json, { up: 'true', down: 'false' }, 'example')).toEqual([]);
	});

	it('reads unquoted booleans and numbers as their text form', () => {
		const json = { multipart: [{ when: { up: true, level: 3 }, apply: { model: 'example:block/x' } }] };
		expect(drawn(json, { up: 'true', level: '3' }, 'example')).toEqual(['example:block/x']);
	});
});

describe('parse failures', () => {
	it('rejects a blockstate stating neither form', () => {
		expect(() => parse({})).toThrow(BlockStateError);
	});

	it('rejects a blockstate stating both forms', () => {
		expect(() => parse({ variants: {}, multipart: [] })).toThrow(BlockStateError);
	});

	it('rejects a variant with no model', () => {
		expect(() => parse({ variants: { '': { x: 90 } } })).toThrow(BlockStateError);
	});

	it('rejects an unparseable variant key, naming the pre-1.13 format', () => {
		// 1.12-era mods write `"normal"`, which needs the numeric-id table the
		// 1.13 floor exists to avoid; the sidecar should say so.
		expect(() => parse({ variants: { normal: { model: 'minecraft:block/x' } } }))
			.toThrow(/pre-1\.13 format/);
	});
});

describe('tolerating a bad case', () => {
	it('keeps the rest of a block when one variant states no model', () => {
		// AE2's crafting monitor states no model for its formed states because the
		// game draws those itself; the other eleven must survive it.
		const json = {
			variants: {
				'facing=north,formed=false': { model: 'ae2:block/monitor' },
				'facing=north,formed=true': {},
			},
		};
		const dropped: string[] = [];
		const definition = parseBlockState('ae2', json, 'ae2:monitor', { onCaseError: (reason) => {
			dropped.push(reason);
		} });
		expect(definition.cases).toHaveLength(1);
		expect(dropped).toHaveLength(1);
		expect(drawnWith(definition, { facing: 'north', formed: 'false' })).toEqual(['ae2:block/monitor']);
	});

	it('still throws when nothing usable is left', () => {
		const json = { variants: { '': {} } };
		expect(() => parseBlockState('ae2', json, 'ae2:cable_bus', { onCaseError: () => {} })).toThrow(BlockStateError);
	});

	it('throws on the first bad case when no handler is given', () => {
		expect(() => parse({ variants: { '': { model: 'a:b' }, 'lit=true': {} } })).toThrow(BlockStateError);
	});
});

describe('loader-defined blockstates', () => {
	it('exports the base model a NeoForge definition loader falls back to', () => {
		// FramedBlocks' camouflage blocks: 233 blockstates whose appearance is
		// composed at runtime, with base_model as the uncamouflaged look.
		const json = {
			'neoforge:definition_type': 'framedblocks:wrapper',
			'base_model': { model: 'framedblocks:block/framed_cube' },
		};
		const notes: string[] = [];
		const definition = parseBlockState('framedblocks', json, 'framedblocks:framed_cube', {
			onNote: (note) => {
				notes.push(note);
			},
		});
		expect(drawnWith(definition, {})).toEqual(['framedblocks:block/framed_cube']);
		expect(notes).toHaveLength(1);
	});

	it('rejects a definition loader that states no base model', () => {
		const json = { 'neoforge:definition_type': 'example:wrapper' };
		expect(() => parseBlockState('example', json, 'example:thing')).toThrow(BlockStateError);
	});
});

describe('collected models', () => {
	it('unions every model a blockstate can name, deduplicated', () => {
		const json = {
			multipart: [
				{ apply: { model: 'example:block/post' } },
				{ when: { north: 'true' }, apply: [{ model: 'example:block/side' }, { model: 'example:block/side', y: 90 }] },
			],
		};
		const models = collectModels(parse(json, 'example')).toSorted((left, right) => left.localeCompare(right));
		expect(models).toEqual(['example:block/post', 'example:block/side']);
	});
});

describe('weighted variant selection', () => {
	it('always picks the only entry', () => {
		expect(weightedVariantIndex([1], 0, 0, 0)).toBe(0);
	});

	it('is stable for a position and varies across positions', () => {
		const weights = [1, 1, 1, 1];
		expect(weightedVariantIndex(weights, 12, 64, -30)).toBe(weightedVariantIndex(weights, 12, 64, -30));
		const picks = new Set<number>();
		for (let x = 0; x < 64; x++) {
			picks.add(weightedVariantIndex(weights, x, 70, 5));
		}
		expect(picks.size).toBeGreaterThan(1);
	});

	it('stays inside the list for every position it is asked about', () => {
		const weights = [5, 1, 2];
		for (let x = -40; x < 40; x++) {
			for (let depth = -3; depth < 3; depth++) {
				const index = weightedVariantIndex(weights, x, 12, depth);
				expect(index).toBeGreaterThanOrEqual(0);
				expect(index).toBeLessThan(weights.length);
			}
		}
	});

	it('respects the weights over a large sample', () => {
		const counts = [0, 0];
		for (let x = 0; x < 400; x++) {
			counts[weightedVariantIndex([9, 1], x, 0, 0)]++;
		}
		// 9:1 has enormous slack, but a picker ignoring weights lands near 50/50.
		expect(counts[0]).toBeGreaterThan(counts[1] * 3);
	});
});
