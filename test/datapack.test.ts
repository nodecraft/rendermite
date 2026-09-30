/**
 * Tags and advancements read out of a version's datapack, and block states out of its generator
 * reports. What is worth protecting is the one spelling a consumer sees across the folder renames
 * 1.21 made, and that a file that will not parse is named rather than quietly missing.
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectDatapack } from '../src/blocks/datapack.ts';
import { readBlockStates } from '../src/blocks/states.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';

describe('collectDatapack', () => {
	it('keys tags by the singular registry name whichever folder spelling the jar used', async () => {
		const resources = new MapResourceManager()
			// Before 1.21
			.set('data', 'minecraft:tags/blocks/logs', JSON.stringify({ values: ['#minecraft:oak_logs'] }))
			// From 1.21
			.set('data', 'minecraft:tags/item/logs', JSON.stringify({ values: ['minecraft:oak_log'] }))
			.set('data', 'minecraft:tags/worldgen/biome/is_ocean', JSON.stringify({ values: ['minecraft:ocean'] }));
		const { tags } = await collectDatapack(resources, ['minecraft']);
		expect(tags).toEqual({
			'block': { 'minecraft:logs': ['#minecraft:oak_logs'] },
			'item': { 'minecraft:logs': ['minecraft:oak_log'] },
			'worldgen/biome': { 'minecraft:is_ocean': ['minecraft:ocean'] },
		});
	});

	it('keeps an optional entry as its id, which is all a consumer can use', async () => {
		const resources = new MapResourceManager()
			.set('data', 'examplemod:tags/block/ores', JSON.stringify({ values: ['examplemod:tin_ore', { id: 'othermod:lead_ore', required: false }] }));
		const { tags } = await collectDatapack(resources, ['examplemod']);
		expect(tags.block['examplemod:ores']).toEqual(['examplemod:tin_ore', 'othermod:lead_ore']);
	});

	it('reads advancement criteria under either folder name and leaves recipe unlocks out', async () => {
		const resources = new MapResourceManager()
			.set('data', 'minecraft:advancements/story/root', JSON.stringify({ criteria: { crafting_table: {} } }))
			.set('data', 'minecraft:advancement/adventure/sleep_in_bed', JSON.stringify({ criteria: { slept_in_bed: {} } }))
			.set('data', 'minecraft:advancement/recipes/misc/stick', JSON.stringify({ criteria: { has_planks: {} } }));
		const { advancements } = await collectDatapack(resources, ['minecraft']);
		expect(advancements).toEqual({
			'minecraft:adventure/sleep_in_bed': ['slept_in_bed'],
			'minecraft:story/root': ['crafting_table'],
		});
	});

	it('names a file it could not read', async () => {
		const resources = new MapResourceManager()
			.set('data', 'minecraft:tags/block/broken', '{ not json')
			.set('data', 'minecraft:advancement/story/empty', JSON.stringify({ display: {} }));
		const result = await collectDatapack(resources, ['minecraft']);
		expect(result.tags).toEqual({});
		expect(result.unreadable.toSorted((left, right) => left.localeCompare(right)))
			.toEqual(['minecraft:advancement/story/empty', 'minecraft:tags/block/broken']);
	});
});

describe('readBlockStates', () => {
	it('keeps every property in the game\'s order and the default state, including ones no model names', async () => {
		const reports = await mkdtemp(path.join(os.tmpdir(), 'rendermite-reports-'));
		await writeFile(path.join(reports, 'blocks.json'), JSON.stringify({
			'minecraft:stone': { states: [{ id: 1, default: true }] },
			'minecraft:oak_stairs': {
				properties: { facing: ['north', 'south'], waterlogged: ['true', 'false'] },
				states: [
					{ id: 10, properties: { facing: 'north', waterlogged: 'true' } },
					{ id: 11, default: true, properties: { facing: 'north', waterlogged: 'false' } },
				],
			},
		}));
		expect(await readBlockStates(reports)).toEqual({
			'minecraft:stone': {},
			'minecraft:oak_stairs': {
				properties: { facing: ['north', 'south'], waterlogged: ['true', 'false'] },
				default: { facing: 'north', waterlogged: 'false' },
			},
		});
	});

	it('gives nothing for a directory with no report, so the pack just goes without', async () => {
		expect(await readBlockStates(await mkdtemp(path.join(os.tmpdir(), 'rendermite-reports-')))).toBeNull();
	});
});
