/**
 * Everything needed to *read* a block pack, and nothing needed to make one.
 *
 * The main entry is a Node toolchain: it reaches jars, rasterizes with `sharp`
 * and writes files. A renderer consuming a published pack needs none of that —
 * it needs the format and the one piece of logic the pack deliberately leaves at
 * runtime, which is matching a placed block's properties against its cases.
 *
 * That evaluation is subtle enough to be worth importing rather than
 * reimplementing. It has a most-constrained-key rule for the overlapping keys
 * mods ship, and a wildcard retry for a state saved before a property existed;
 * a consumer that reimplements it and misses the retry draws a hole where every
 * Functional Storage drawer stands. `test/pack-entry.test.ts` holds this entry
 * to being browser-safe: no `node:` builtin, no dependency, nothing from the
 * exporter.
 *
 * @example
 * ```ts
 * import { evaluateBlockState } from '@nodecraft/rendermite/pack';
 * import type { BlockPackBlockState } from '@nodecraft/rendermite/pack';
 *
 * const state: BlockPackBlockState = blockstates['minecraft:oak_stairs'];
 * const models = evaluateBlockState(
 *   state.variants ? { kind: 'variants', cases: state.variants } : { kind: 'multipart', cases: state.multipart },
 *   { facing: 'north', half: 'bottom', shape: 'straight' },
 * );
 * ```
 */

export { evaluateBlockState, matchesCondition, weightedVariantIndex } from './blocks/blockstate-eval.ts';
export type {
	BlockModelVariant,
	BlockProperties,
	BlockStateDefinition,
	BlockStateMultipartCase,
	BlockStateVariantCase,
	MultipartCondition,
} from './blocks/blockstate-eval.ts';
export type {
	BlockPackAtlasFile,
	BlockPackAtlasPage,
	BlockPackBiomesFile,
	BlockPackBlockState,
	BlockPackBlockStatesFile,
	BlockPackElement,
	BlockPackFace,
	BlockPackMetaFile,
	BlockPackModel,
	BlockPackModelsFile,
	BlockPackRenderLayer,
	BlockPackSprite,
	BlockPackSpriteFrame,
	BlockPackTintsFile,
	BlockPackVariant,
} from './blocks/pack-format.ts';
export type { MeshGroup, ObjMesh } from './blocks/obj-mesh.ts';
export type { BlockTint, BlockTintPack } from './blocks/tints.ts';
export type { BiomeClimate, BiomeClimatePack } from './blocks/biomes.ts';
