/**
 * Block light emission read out of the code, against real client jars.
 *
 * No jar states how bright a block is — a torch's 14 is a lambda in `Blocks.<clinit>` — so the only
 * automatic source is the bytecode, and the only check on reading it is a table a person transcribed.
 * `VANILLA_LIGHT` is that table. Every version below must come out *exactly* equal to it, in both
 * directions: an emitter the interpreter misses is a dark torch in the viewer, and one it invents is a
 * glowing stone. Either fails here.
 *
 * The versions bracket everything that has changed in how light is stated: `lightValue(int)` plus a
 * `getLightValue` override before 1.16, `lightLevel(ToIntFunction)` from 1.16, the collection-based
 * registration of 26.x, and the unobfuscated jars of the 26 line.
 */
import { describe, expect, it } from 'vitest';

import { fixturesDir, vanillaJar } from './fixtures/index.ts';
import { blockLightLevel } from '../src/blocks/light-eval.ts';
import { collectBlockLight, vanillaLightAt } from '../src/blocks/light.ts';
import { JarClassReader } from '../src/entities/jar-classes.ts';
import { parseMappings, remapDescriptor } from '../src/entities/mappings.ts';
import { JarResourceManager } from '../src/resources/jar.ts';

import type { BlockPackLight } from '../src/blocks/pack-format.ts';

/** Every version the fixtures hold from the pack's floor up; each is a different jar to read. */
const VERSIONS = ['1.13.2', '1.14.4', '1.15.2', '1.16.5', '1.17.1', '1.18.2', '1.19.4', '1.20.4', '1.21.1', '1.21.4', '1.21.8', '1.21.11', '26.1.2', '26.2'];

async function extract(version: string): Promise<{ light: Record<string, BlockPackLight>; failures: Array<{ id: string; reason: string; }>; blockIds: string[]; }> {
	const jar = vanillaJar(version);
	const classes = new JarClassReader(jar);
	const resources = new JarResourceManager(jar);
	try {
		const locators = await resources.listResources('blockstate', 'minecraft');
		const blockIds = locators.map(locator => locator.toString());
		const result = await collectBlockLight({ version, cacheDir: fixturesDir, classes, blockIds });
		return { light: result.light, failures: result.failures, blockIds };
	} finally {
		await classes.close();
	}
}

describe('block light extraction', () => {
	for (const version of VERSIONS) {
		it(`reads ${version} exactly as the vanilla table has it`, async () => {
			const { light, failures, blockIds } = await extract(version);
			const oracle = vanillaLightAt(version);
			const present = new Set(blockIds.map(id => id.slice('minecraft:'.length)));

			// Nothing unreadable: a block the interpreter could not follow would ship dark
			expect(failures).toStrictEqual([]);

			// Every emitter read matches the table, and every table entry the version has was read
			const read: Record<string, BlockPackLight> = {};
			for (const [id, level] of Object.entries(light)) {
				read[id.slice('minecraft:'.length)] = level;
			}
			const expected: Record<string, BlockPackLight> = {};
			for (const [path, level] of Object.entries(oracle)) {
				if (present.has(path)) {
					expected[path] = level;
				}
			}
			expect(read).toStrictEqual(expected);
		}, 120000);
	}
});

describe('vanillaLightAt', () => {
	it('withholds the enchanting table before 1.18, when it did not glow', () => {
		expect(vanillaLightAt('1.17.1').enchanting_table).toBeUndefined();
		expect(vanillaLightAt('1.18.2').enchanting_table).toBe(7);
	});
});

describe('blockLightLevel', () => {
	it('answers a constant, a case, and the default', () => {
		const lamp: BlockPackLight = { default: 0, cases: [{ when: { lit: 'true' }, level: 15 }] };
		expect(blockLightLevel(15, undefined)).toBe(15);
		expect(blockLightLevel(lamp, { lit: 'true', facing: 'north' })).toBe(15);
		expect(blockLightLevel(lamp, { lit: 'false' })).toBe(0);
		expect(blockLightLevel(lamp, undefined)).toBe(0);
	});

	it('takes the first case whose every property matches, and 0 for a block the file lacks', () => {
		const candle: BlockPackLight = {
			default: 0,
			cases: [
				{ when: { candles: '1', lit: 'true' }, level: 3 },
				{ when: { candles: '2', lit: 'true' }, level: 6 },
			],
		};
		expect(blockLightLevel(candle, { candles: '2', lit: 'true' })).toBe(6);
		expect(blockLightLevel(candle, { candles: '2', lit: 'false' })).toBe(0);
		expect(blockLightLevel(undefined, { lit: 'true' })).toBe(0);
	});
});

describe('member mappings', () => {
	/**
	 * A mod names the game's classes and members by their original names; following it into an
	 * obfuscated client means renaming a field, a method and the classes in its descriptor.
	 */
	it('reads fields and methods under their class, keyed as a constant pool spells them', () => {
		const mappings = parseMappings([
			'net.minecraft.world.level.block.Blocks -> dga:',
			'    net.minecraft.world.level.block.Block TORCH -> co',
			'    12:12:net.minecraft.world.level.block.state.BlockBehaviour$Properties lightLevel(java.util.function.ToIntFunction) -> a',
			'    void register(java.lang.String,net.minecraft.world.level.block.Block) -> b',
			'net.minecraft.world.level.block.Block -> dfy:',
		].join('\n'));

		expect(mappings.fieldOf.get('net.minecraft.world.level.block.Blocks.TORCH')).toBe('co');
		expect(mappings.methodOf.get('net.minecraft.world.level.block.Blocks.lightLevel(Ljava/util/function/ToIntFunction;)Lnet/minecraft/world/level/block/state/BlockBehaviour$Properties;')).toBe('a');
		expect(mappings.methodOf.get('net.minecraft.world.level.block.Blocks.register(Ljava/lang/String;Lnet/minecraft/world/level/block/Block;)V')).toBe('b');
		expect(remapDescriptor('(Ljava/lang/String;Lnet/minecraft/world/level/block/Block;)V', mappings.obfuscatedOf)).toBe('(Ljava/lang/String;Ldfy;)V');
	});
});
