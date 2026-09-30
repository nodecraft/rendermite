export { ResourceLocator, InvalidResourceLocatorError } from './resources/locator.ts';
export { FolderResourceManager, LayeredResourceManager, ResourceKind } from './resources/manager.ts';
export type { ResourceManager, ResourceKindName } from './resources/manager.ts';
export { ModelLoader, ModelResolutionError, resolveTexture, salvageJson } from './models/loader.ts';
export type { ResolvedModel } from './models/loader.ts';
export { TextureLoader, TextureResolutionError } from './textures/loader.ts';
export type { Texture, TextureMeta } from './textures/loader.ts';
export { renderModel, pointResize, boxDownscale, ItemRenderError } from './render/renderer.ts';
export type { RenderOptions } from './render/renderer.ts';
export { lightsForProfile, LightingProfile } from './render/lighting.ts';
export type { LightingProfileName, LightSource } from './render/lighting.ts';
export { toFloatTexture, toByteTexture } from './render/blend.ts';
export type { FloatTexture } from './render/blend.ts';
export { evaluateItemModel, defaultProperties, InvalidItemDefinitionError, UNKNOWN_MODEL } from './items/definition.ts';
export type { ItemRenderInstruction, ItemProperties, TintDefinition } from './items/definition.ts';
export { discoverItems, resolveItem, ItemResolutionError } from './items/discovery.ts';
export type { DiscoveredItem, ItemDiscoveryOptions } from './items/discovery.ts';
export { resolveTint, resolveTints, parseTintValue, DYE_COLORS, InvalidTinterDefinitionError } from './render/tints.ts';
export { encodeIcon, encodeAnimatedIcon } from './output/encode.ts';
export type { EncodedIcon, EncodeOptions, EncodedAnimatedIcon, AnimatedEncodeOptions } from './output/encode.ts';
export { minifyStylesheet } from './output/minify.ts';
export { renderModelFrames } from './render/renderer.ts';
export type { RenderedFrames } from './render/renderer.ts';
export { AnimatedTexture } from './textures/loader.ts';
export { builtinDynamicResources } from './dynamic/generators.ts';
export { prepareVersionResources, eraForVersion, compareVersions } from './versions/prepare.ts';
export { prepareModResources } from './mods/prepare.ts';
export { generateStylesheet, itemClass } from './output/stylesheet.ts';
export type { ItemStyle, StylesheetOptions } from './output/stylesheet.ts';
export { run } from './run.ts';
export type { RunOptions, RunResult, ItemFailure } from './run.ts';
export { JarResourceManager, UnsafeJarError, isUnsafeEntryPath } from './resources/jar.ts';
export { parseAtlasSources, createAtlasResolver, AtlasSourceError } from './atlas/sources.ts';
export type { AtlasSource, AtlasResolver, ResolvedSprite } from './atlas/sources.ts';
export { exportBlockPack } from './blocks/export.ts';
export type { ExportBlockPackOptions, BlockPackResult, BlockPackFailure } from './blocks/export.ts';
export {
	BlockStateError,
	collectModels,
	evaluateBlockState,
	matchesCondition,
	parseBlockState,
	weightedVariantIndex,
} from './blocks/blockstate-eval.ts';
export type {
	BlockModelVariant,
	BlockProperties,
	BlockStateDefinition,
	BlockStateMultipartCase,
	BlockStateVariantCase,
	MultipartCondition,
} from './blocks/blockstate-eval.ts';
export { buildObjMesh, ObjMeshError } from './blocks/obj-mesh.ts';
export type { MeshGroup, ObjMesh } from './blocks/obj-mesh.ts';
export { packAtlas } from './blocks/atlas-pack.ts';
export type { PackEntry, PackOptions, PackedAtlas, PackedPage, PackedRect } from './blocks/atlas-pack.ts';
export { buildBlockTints, UNREGISTERED_TINTS } from './blocks/tints.ts';
export type { BlockTint, BlockTintPack } from './blocks/tints.ts';
export { buildBiomeClimates, parseBiomeClimate, vanillaBiomesFor, LEGACY_BIOMES, PRE_JAR_BIOMES, VANILLA_BIOME_CLIMATES, DEFAULT_WATER_COLOR } from './blocks/biomes.ts';
export type { BiomeClimate, BiomeClimatePack } from './blocks/biomes.ts';
