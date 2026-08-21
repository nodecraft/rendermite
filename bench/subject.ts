/**
 * The whole surface the benchmarks reach `src/` through.
 *
 * `scripts/bench-against.ts` copies this file into the base worktree, where its
 * relative imports resolve to that commit's `src/`. Everything else a benchmark
 * touches (the fixtures, the harness, the inputs) stays on this side, so a
 * paired run measures two source trees with one ruler.
 *
 * Keep it a re-export and nothing else. A helper written here would be measured
 * as part of whichever side loaded it.
 */

export { buildModelNameIndex, classReader, linkEntityModel } from '../src/entities/link.ts';
export { identityMappings, isObfuscated, loadMappings } from '../src/entities/mappings.ts';
export { extractModel } from '../src/entities/model-bytecode.ts';
export { extractInheritedModel } from '../src/entities/inherit.ts';
export { loadModelCode } from '../src/entities/model-code.ts';
export { JarClassReader } from '../src/entities/jar-classes.ts';
export { parseClassFile } from '../src/entities/classfile.ts';
export { defaultProperties } from '../src/items/definition.ts';
export { discoverItems, resolveItem } from '../src/items/discovery.ts';
export { ModelLoader } from '../src/models/loader.ts';
export { encodeAnimatedIcon } from '../src/output/encode.ts';
export { combineFaceBuffers } from '../src/render/compose.ts';
export { createFaceBuffer } from '../src/render/rasterizer.ts';
export { renderModelFrames } from '../src/render/renderer.ts';
export { JarResourceManager } from '../src/resources/jar.ts';
export { ResourceLocator } from '../src/resources/locator.ts';
export { openZip } from '../src/resources/zip-reader.ts';
export { TextureLoader } from '../src/textures/loader.ts';

export type { ExtractedModel, Part } from '../src/entities/model.ts';
export type { ResolvedModel } from '../src/models/loader.ts';
export type { FloatTexture } from '../src/render/blend.ts';
export type { FaceBuffer } from '../src/render/rasterizer.ts';
export type { RenderOptions } from '../src/render/renderer.ts';
