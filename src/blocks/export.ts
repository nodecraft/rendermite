/**
 * Block pack export: block geometry and textures as data, for a renderer that
 * draws blocks itself rather than consuming finished icons.
 *
 * Everything above the rasterizer is reused unchanged — jar layering, parent
 * chain flattening, `#texture` resolution, atlas sources — and the output is
 * flat: a stitched atlas plus JSON that names sprites, baked elements and the
 * blockstate → model mapping with nothing left to resolve at runtime.
 *
 * Scope is Java Edition, 1.13 and up (see docs/block-pack-export.md). Nothing
 * here is version-gated: 1.13+ sits entirely inside the `models` and `modern`
 * eras, so `prepareVersionResources` layers the jar and little else.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';

import { packAtlas } from './atlas-pack.ts';
import { INVISIBLE_BLOCKS, blockEntityGeometry, synthesizeVariants } from './block-entities.ts';
import { collectModels, parseBlockState } from './blockstate-eval.ts';
import { buildObjMesh } from './obj-mesh.ts';
import { buildBlockTints } from './tints.ts';
import { loadAtlasResolver } from '../atlas/registry.ts';
import { ModelLoader, resolveTexture, salvageJson } from '../models/loader.ts';
import { ResourceLocator } from '../resources/locator.ts';
import { FolderResourceManager, LayeredResourceManager } from '../resources/manager.ts';
import { TextureLoader } from '../textures/loader.ts';

import type { BlockModelVariant, BlockStateDefinition, BlockStateVariantCase } from './blockstate-eval.ts';
import type {
	BlockPackAtlasFile,
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
} from './pack-format.ts';
import type { ResolvedModel } from '../models/loader.ts';
import type {
	FaceDirectionName,
	ModelElementJson,
	Vec3,
	Vec4,
} from '../models/types.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { Texture } from '../textures/loader.ts';

export interface ExportBlockPackOptions {
	resources: ResourceManager;
	/** Directory the pack is written into; the pack *is* the directory. */
	output: string;
	/** Recorded in meta.json. One version per pack, immutable once published. */
	version: string;
	namespaces?: string[];
	/**
	 * Path to the vendored builtin pack (`src/builtin.ts`'s `builtinPackPath`).
	 * Layered *under* the input so it only supplies the `renderchest:` and
	 * `mobheads:` namespaces nothing else has, never shadowing a real one. It is
	 * what gives chests, shulker boxes and the rest a shape; without it those
	 * blocks stay empty and are recorded as such.
	 */
	builtin?: string;
	/** Edge-extended border per sprite side (default 4). */
	padding?: number;
	/** Ceiling on an atlas page's dimensions (default 4096). */
	maxPageSize?: number;
	onProgress?: (stage: string, done: number, total: number) => void;
}

export interface BlockPackFailure {
	id: string;
	/**
	 * `intentional` is not a failure: it marks a block that is empty because the
	 * game draws nothing for it. Filter it out to get the real gaps.
	 */
	kind: 'blockstate' | 'model' | 'texture' | 'sprite' | 'geometry' | 'tint' | 'intentional';
	reason: string;
}

export interface BlockPackResult {
	blocks: number;
	models: number;
	sprites: number;
	pages: number;
	/** Files actually written — the only trustworthy success signal. */
	writtenFiles: number;
	failures: BlockPackFailure[];
}

/** `render_type` values collapsed onto the pack's three layers. */
const RENDER_TYPES: Record<string, BlockPackRenderLayer> = {
	solid: 'solid',
	cutout: 'cutout',
	cutout_mipped: 'cutout',
	cutout_mipped_all: 'cutout',
	tripwire: 'cutout',
	translucent: 'translucent',
	translucent_moving_block: 'translucent',
};

/**
 * A sprite whose strip is longer than this exports as its first frame only.
 * A broken `.mcmeta` can claim thousands of frames, and packing them would
 * blow the atlas out for one texture.
 */
const MAX_FRAMES_PER_SPRITE = 256;

const FACE_DIRECTIONS = new Set<string>(['down', 'up', 'north', 'south', 'west', 'east']);

/** Old models spell the vertical faces `bottom`/`top` in `cullface`. */
const CULLFACE_ALIASES: Record<string, FaceDirectionName> = { bottom: 'down', top: 'up' };

/**
 * Vanilla's own id for the missing-texture sprite. A face whose texture does
 * not resolve is drawn by the game in black and magenta rather than skipped —
 * Blockbench leaves `"texture": "#missing"` on unassigned faces and mods ship
 * models naming textures they forgot to include. Dropping those faces would
 * put holes in geometry the player can see, and would read as our bug rather
 * than the mod's.
 */
const MISSING_SPRITE = 'minecraft:missingno';

/**
 * Fluids are blocks in `blockstates.json` but the game meshes them in code, so
 * their models state nothing and their textures would otherwise never reach the
 * atlas — leaving a consumer that has to mesh fluids itself with no pixels to do
 * it from.
 *
 * Which textures those are is read off the files rather than listed: a fluid's
 * two frames are `<name>_still` and `<name>_flow` (or `_flowing`) by a
 * convention every loader follows, and mods put them wherever they like —
 * Create under `fluid/`, Immersive Engineering under `block/fluid/`, Mekanism
 * under `liquid/`. A vanilla-only list would have missed all of them.
 */
const FLUID_SUFFIX = /_(?:still|flow|flowing)$/;

/** Sampled where water meets a non-opaque neighbour; matches no suffix. */
const EXTRA_FLUID_SPRITES = ['minecraft:block/water_overlay'];

/** `MissingTextureAtlasSprite`: 16x16, black and magenta in 8px quarters. */
function missingTexture(): Texture {
	const size = 16;
	const data = new Uint8ClampedArray(size * size * 4);
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const magenta = (x < 8) !== (y < 8);
			const offset = (y * size + x) * 4;
			data[offset] = magenta ? 248 : 0;
			data[offset + 1] = 0;
			data[offset + 2] = magenta ? 248 : 0;
			data[offset + 3] = 255;
		}
	}
	return { width: size, height: size, data };
}

/**
 * Vanilla's `BlockElement.uvsByFace`: the UV a face gets when the model states
 * none. Deliberately not `render/geometry.ts`'s auto-UVs — those are in the
 * rasterizer's own unflipped convention, and the pack has to speak the same
 * language a model file's explicit `uv` does.
 */
function defaultFaceUv(direction: FaceDirectionName, from: Vec3, to: Vec3): Vec4 {
	switch (direction) {
		case 'down': {
			return [from[0], 16 - to[2], to[0], 16 - from[2]];
		}
		case 'up': {
			return [from[0], from[2], to[0], to[2]];
		}
		case 'north': {
			return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]];
		}
		case 'south': {
			return [from[0], 16 - to[1], to[0], 16 - from[1]];
		}
		case 'west': {
			return [from[2], 16 - to[1], to[2], 16 - from[1]];
		}
		case 'east': {
			return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]];
		}
	}
}

/**
 * Alpha decides the render layer: vanilla assets do not state cutout versus
 * translucent (`render_type` is a loader extension adopted only recently), and
 * inferring it covers mods for free.
 */
function inferRenderLayer(frames: Texture[]): BlockPackRenderLayer {
	let sawHole = false;
	for (const frame of frames) {
		for (let offset = 3; offset < frame.data.length; offset += 4) {
			const alpha = frame.data[offset];
			if (alpha === 0) {
				sawHole = true;
			} else if (alpha !== 255) {
				return 'translucent';
			}
		}
	}
	return sawHole ? 'cutout' : 'solid';
}

function sortedByKey<T>(entries: Record<string, T>): Record<string, T> {
	return Object.fromEntries(Object.entries(entries).toSorted(([left], [right]) => left.localeCompare(right)));
}

/**
 * Serialize a definition, keeping only the variants whose model was exported.
 * Returns null when that leaves nothing — the consumer must never be handed a
 * model id the pack does not carry.
 */
/**
 * Shifts a vendored model's boxes without touching anything else. The array is
 * returned as-is when there is nothing to shift, because models loaded from a
 * shared parent hand out the same element array and callers rely on that.
 */
function translateElements(elements: ModelElementJson[], offset?: [number, number, number]): ModelElementJson[] {
	if (offset === undefined) {
		return elements;
	}
	const move = (point: Vec3): Vec3 => [point[0] + offset[0], point[1] + offset[1], point[2] + offset[2]];
	return elements.map((element) => {
		const rotation = element.rotation;
		return {
			...element,
			from: move(element.from),
			to: move(element.to),
			...(rotation && { rotation: { ...rotation, origin: move(rotation.origin) } }),
		};
	});
}

function serializeBlockState(
	definition: BlockStateDefinition,
	exported: (model: string) => boolean,
): BlockPackBlockState | null {
	/** Every default dropped, since most variants state none of these. */
	const serializeApply = (apply: BlockModelVariant[]): BlockPackVariant[] => apply.filter(variant => exported(variant.model)).map((variant) => {
		return {
			model: variant.model,
			...(variant.x !== 0 && { x: variant.x }),
			...(variant.y !== 0 && { y: variant.y }),
			...(variant.z !== 0 && { z: variant.z }),
			...(variant.uvlock && { uvlock: true as const }),
			...(variant.weight !== 1 && { weight: variant.weight }),
		};
	});
	if (definition.kind === 'variants') {
		const cases = definition.cases.flatMap((entry) => {
			const apply = serializeApply(entry.apply);
			return apply.length === 0 ? [] : [{ when: entry.when, apply }];
		});
		return cases.length === 0 ? null : { variants: cases };
	}
	const cases = definition.cases.flatMap((entry) => {
		const apply = serializeApply(entry.apply);
		return apply.length === 0 ? [] : [{ when: entry.when, apply }];
	});
	return cases.length === 0 ? null : { multipart: cases };
}

/**
 * Any texture the model binds, for a model that declares no `particle`. Ordered
 * by the chain's own key order so a run is reproducible, and `particle` itself
 * is not a candidate: it was already tried.
 */
function firstBoundTexture(model: ResolvedModel): ResourceLocator | null {
	for (const name of Object.keys(model.textures)) {
		if (name === 'particle') {
			continue;
		}
		const resolved = resolveTexture(model, `#${name}`);
		if (resolved !== null) {
			return resolved;
		}
	}
	return null;
}

interface ItemModelSubstitute {
	id: string;
	emitted: BlockPackModel;
	sprites: Set<string>;
	tintIndices: Set<number>;
}

/**
 * The block's own item model, baked, for a block model that draws nothing.
 *
 * A mod that builds a block's shape in Java still has to put something in the
 * inventory, so it ships an item model with real geometry, and that is the
 * closest the assets come to describing the block: Ender IO's conduit is a cube
 * of its own texture, AE2's formed quantum ring is the ring, MoreRed's wire is
 * the cross it draws with nothing connected. Flat icons fall out on their own,
 * since `item/generated` states no elements.
 *
 * Null unless the substitute is whole: a part-magenta stand-in reads as a broken
 * texture, which is worse than the recorded gap it replaces.
 */
async function itemModelSubstitute(
	blockId: string,
	resources: ResourceManager,
	models: ModelLoader,
): Promise<ItemModelSubstitute | null> {
	const block = ResourceLocator.tryParse(blockId);
	if (block === null) {
		return null;
	}
	const item = new ResourceLocator(block.namespace, `item/${block.path}`);
	if (!await resources.hasResource('model', item)) {
		return null;
	}
	let resolved: ResolvedModel;
	try {
		resolved = await models.load(item.toString());
	} catch {
		return null;
	}
	// Face-level losses belong to the model this stands in for, not to the pack;
	// they are only interesting if the substitute survives, and it is dropped
	// whole below if any of its sprites is missing.
	const { emitted, sprites, tintIndices } = bakeModel(item.toString(), resolved, []);
	if (emitted.elements.length === 0) {
		return null;
	}
	const present = await Promise.all([...sprites]
		.map(async sprite => sprite !== MISSING_SPRITE && await resources.hasResource('texture', ResourceLocator.parse(sprite))));
	if (present.includes(false)) {
		return null;
	}
	return { id: item.toString(), emitted, sprites, tintIndices };
}

/** Bake one flattened model into pack form, reporting every face it loses. */
function bakeModel(
	id: string,
	model: ResolvedModel,
	failures: BlockPackFailure[],
): { emitted: BlockPackModel; sprites: Set<string>; tintIndices: Set<number>; } {
	const sprites = new Set<string>();
	const tintIndices = new Set<number>();
	const elements: BlockPackElement[] = [];
	for (const element of model.elements) {
		const faces: Partial<Record<FaceDirectionName, BlockPackFace>> = {};
		for (const [name, face] of Object.entries(element.faces)) {
			if (!face || !FACE_DIRECTIONS.has(name)) {
				continue;
			}
			const direction = name as FaceDirectionName;
			const texture = resolveTexture(model, face.texture);
			if (texture === null) {
				failures.push({ id, kind: 'texture', reason: `unresolved texture ${face.texture} on ${direction}; using the missing-texture sprite` });
			}
			const sprite = texture === null ? MISSING_SPRITE : texture.toString();
			sprites.add(sprite);
			const cullRaw = typeof face.cullface === 'string' ? face.cullface : null;
			const cullface = cullRaw === null
				? undefined
				: (CULLFACE_ALIASES[cullRaw] ?? (FACE_DIRECTIONS.has(cullRaw) ? cullRaw as FaceDirectionName : undefined));
			if (typeof face.tintindex === 'number' && face.tintindex >= 0) {
				tintIndices.add(face.tintindex);
			}
			faces[direction] = {
				sprite,
				// Mods ship elements outside the 0–16 cube; nothing is clamped.
				uv: face.uv ?? defaultFaceUv(direction, element.from, element.to),
				...(face.rotation && { rotation: face.rotation }),
				...(typeof face.tintindex === 'number' && face.tintindex >= 0 && { tintindex: face.tintindex }),
				...(cullface !== undefined && { cullface }),
			};
		}
		if (Object.keys(faces).length === 0) {
			continue;
		}
		elements.push({
			from: element.from,
			to: element.to,
			...(element.rotation && { rotation: element.rotation }),
			...(element.shade === false && { shade: false }),
			faces,
		});
	}
	const renderType = model.renderType === null ? undefined : RENDER_TYPES[model.renderType];
	// A model with nothing to draw is the one case where the particle is the
	// only colour a consumer has, and the models that draw nothing are exactly
	// the ones least likely to declare one. Any texture the model binds is a
	// better stand-in than magenta, so the first one stands in for it.
	const particle = resolveTexture(model, '#particle')
		?? (elements.length === 0 ? firstBoundTexture(model) : null);
	if (particle !== null) {
		sprites.add(particle.toString());
	}
	return {
		emitted: {
			ao: model.ambientOcclusion,
			elements,
			...(particle !== null && { particle: particle.toString() }),
			...(renderType !== undefined && { renderType }),
			...(model.splitParts && { multiblock: model.splitParts }),
		},
		sprites,
		tintIndices,
	};
}

export async function exportBlockPack(options: ExportBlockPackOptions): Promise<BlockPackResult> {
	const { output, version } = options;
	// Under the input, not over it: the builtin pack is only here for the
	// namespaces nothing else provides, and layering it above would let its item
	// overrides shadow a real block model.
	const resources = options.builtin
		? new LayeredResourceManager([options.resources, new FolderResourceManager(options.builtin)])
		: options.resources;
	const namespaces = options.namespaces ?? ['minecraft'];
	const failures: BlockPackFailure[] = [];
	const report = (stage: string, done: number, total: number): void => options.onProgress?.(stage, done, total);

	const textures = new TextureLoader(resources);
	// Not optional: paletted_permutations and unstitch sources synthesize sprites
	// that have no file under textures/, and skipping the resolver loses them.
	textures.setAtlasResolver(await loadAtlasResolver(resources, locator => textures.load(locator)));
	const models = new ModelLoader(resources);

	// 1. Blockstates → normalized definitions, and the models they can name.
	// Serialization waits until step 3, once it is known which of those models
	// actually resolved — the pack must never name a model it does not carry.
	const definitions = new Map<string, BlockStateDefinition>();
	const blockModels = new Map<string, string[]>();
	const modelRefs = new Set<string>();
	const blockLocators: ResourceLocator[] = [];
	for (const namespace of namespaces) {
		blockLocators.push(...await resources.listResources('blockstate', namespace));
	}
	let done = 0;
	for (const locator of blockLocators) {
		const id = locator.toString();
		report('blockstates', ++done, blockLocators.length);
		const raw = await resources.getResource('blockstate', locator);
		if (raw === null) {
			failures.push({ id, kind: 'blockstate', reason: 'listed but unreadable' });
			continue;
		}
		try {
			// Mods ship JSON with trailing junk that the game's parser tolerates.
			const text = raw.toString('utf8');
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				json = salvageJson(text);
			}
			const definition = parseBlockState(locator.namespace, json, id, {
				onCaseError: (reason) => {
					failures.push({ id, kind: 'blockstate', reason: `${reason}; case dropped` });
				},
				onNote: (reason) => {
					failures.push({ id, kind: 'blockstate', reason });
				},
			});
			const references = collectModels(definition);
			definitions.set(id, definition);
			blockModels.set(id, references);
			for (const model of references) {
				modelRefs.add(model);
			}
		} catch (err) {
			failures.push({ id, kind: 'blockstate', reason: (err as Error).message });
		}
	}

	// 2. Models → baked elements with concrete sprites.
	const emittedModels: Record<string, BlockPackModel> = {};
	const modelTintIndices = new Map<string, Set<number>>();
	const spriteIds = new Set<string>();
	done = 0;
	for (const reference of [...modelRefs].toSorted((left, right) => left.localeCompare(right))) {
		report('models', ++done, modelRefs.size);
		let resolved: ResolvedModel;
		try {
			resolved = await models.load(reference);
		} catch (err) {
			failures.push({ id: reference, kind: 'model', reason: (err as Error).message });
			continue;
		}
		const { emitted, sprites, tintIndices } = bakeModel(reference, resolved, failures);
		if (resolved.splitParts) {
			failures.push({
				id: reference,
				kind: 'geometry',
				reason: `split multiblock spanning ${resolved.splitParts.length} block positions; the pack carries the whole mesh, since which slice a position draws lives in the block entity`,
			});
		}
		if (resolved.obj) {
			try {
				const mesh = await buildObjMesh(resolved, resources, MISSING_SPRITE);
				if (mesh) {
					emitted.mesh = mesh.groups;
					for (const group of mesh.groups) {
						sprites.add(group.sprite);
					}
					for (const material of mesh.unresolved) {
						failures.push({ id: reference, kind: 'texture', reason: `OBJ material ${material} resolves to no texture; using the missing-texture sprite` });
					}
					// Several named objects in one OBJ almost always means the loader
					// draws a subset chosen at runtime — connection states, an
					// inserted item, a lamp that is on. Where the flattener could not
					// name that subset the pack draws all of them, which is visibly
					// wrong, so it says which objects are in play.
					if (mesh.conditional && mesh.available.length > 1) {
						failures.push({
							id: reference,
							kind: 'geometry',
							reason: `the loader picks between this OBJ's ${mesh.available.length} named objects at runtime (${mesh.available.slice(0, 8).join(', ')}${mesh.available.length > 8 ? ', …' : ''}) and nothing in the assets says which; the pack draws all of them, tagged with their object names`,
						});
					}
				}
			} catch (err) {
				failures.push({ id: reference, kind: 'geometry', reason: (err as Error).message });
			}
		}
		emittedModels[reference] = emitted;
		modelTintIndices.set(reference, tintIndices);
		for (const sprite of sprites) {
			spriteIds.add(sprite);
		}
	}

	// 2a. Blocks the game draws from Java have an empty model and a blockstate
	// with nothing to orient by. Where geometry is vendored for one, swap it in
	// and synthesise the variants the blockstate never carried.
	for (const [id, references] of blockModels) {
		const drawsSomething = references.some((reference) => {
			const model = emittedModels[reference];
			return model !== undefined && (model.elements.length > 0 || model.mesh?.length);
		});
		if (drawsSomething) {
			continue;
		}
		const invisible = INVISIBLE_BLOCKS[id];
		if (invisible !== undefined) {
			failures.push({ id, kind: 'intentional', reason: `empty on purpose: ${invisible}` });
			continue;
		}
		const geometry = await blockEntityGeometry(id, { resources, textures, models });
		if (geometry === null) {
			// Every empty block is accounted for one way or another, so a
			// consumer can draw the gaps rather than silently miss them.
			failures.push({ id, kind: 'geometry', reason: 'the game draws this block in code and no geometry is vendored for it' });
			continue;
		}
		// A shape per model the block can take — one for most, three for a
		// chest's single and paired forms — multiplied by the orientations each
		// can be placed in.
		const cases: BlockStateVariantCase[] = [];
		const substituted: string[] = [];
		for (const shape of geometry.shapes) {
			// The table derives some texture names from the block's own (a sign's
			// wood, a double chest's wider sheet), which lets a mod following the
			// convention benefit too — but only once the texture is known to be
			// there. Substituting a magenta sign would be worse than leaving the
			// block empty and saying so. Checked per shape because an ender chest
			// has a single form and no paired one.
			const textures = { ...geometry.textures, ...shape.textures };
			const bindable = await Promise.all(Object.values(textures)
				.map(async texture => resources.hasResource('texture', ResourceLocator.parse(texture))));
			if (bindable.includes(false)) {
				continue;
			}
			let resolved: ResolvedModel;
			try {
				resolved = await models.load(shape.model);
			} catch (err) {
				failures.push({ id, kind: 'geometry', reason: `substitute ${shape.model} did not load: ${(err as Error).message}` });
				continue;
			}
			const bound = {
				...resolved,
				textures: { ...resolved.textures, ...textures },
				elements: translateElements(resolved.elements, shape.translate),
			};
			// Named `rendermite:` so nothing mistakes vendored geometry for a
			// model the jar shipped.
			const suffix = Object.values(shape.when ?? {}).join('_');
			const substituteId = `rendermite:block/${ResourceLocator.parse(id).path}${suffix && `_${suffix}`}`;
			const { emitted, sprites, tintIndices } = bakeModel(substituteId, bound, failures);
			if (emitted.elements.length === 0) {
				continue;
			}
			// A substitute is a guess about a block the assets do not describe,
			// so a half-bound one is worse than none: the block would draw with
			// magenta patches and look like a broken texture rather than a gap.
			// The declared bindings were checked above; these are the ones the
			// vendored model brings with it, which a version can have dropped.
			const present = await Promise.all([...sprites]
				.map(async sprite => sprite !== MISSING_SPRITE && await resources.hasResource('texture', ResourceLocator.parse(sprite))));
			if (present.includes(false)) {
				failures.push({ id, kind: 'geometry', reason: `substitute ${shape.model} left textures unresolved, so the block is left empty rather than part magenta` });
				continue;
			}
			const still = emitted.elements[0].faces.up?.sprite;
			const flow = emitted.elements[0].faces.north?.sprite;
			if (geometry.fluid !== undefined && still !== undefined && flow !== undefined) {
				emitted.fluid = { still, flow, ...geometry.fluid };
			}
			emittedModels[substituteId] = emitted;
			modelTintIndices.set(substituteId, tintIndices);
			substituted.push(substituteId);
			for (const sprite of sprites) {
				spriteIds.add(sprite);
			}
			for (const variant of synthesizeVariants(geometry.orient)) {
				cases.push({
					when: { ...shape.when, ...variant.when },
					apply: [{ model: substituteId, x: variant.x, y: variant.y, z: 0, uvlock: false, weight: 1 }],
				});
			}
		}
		if (cases.length === 0) {
			// Matched the table but nothing survived — almost always a texture
			// the table's naming convention predicted and the pack does not have,
			// which is a mod naming its signs its own way rather than a bug.
			failures.push({
				id,
				kind: 'geometry',
				reason: `the game draws this block in code; vendored ${geometry.shapes.map(shape => shape.model).join(', ')} could not be bound to it`,
			});
			continue;
		}
		definitions.set(id, { kind: 'variants', cases });
		blockModels.set(id, substituted);
		failures.push({
			id,
			kind: 'geometry',
			reason: `the game draws this block in code; the pack substitutes vendored geometry from ${geometry.shapes.map(shape => shape.model).join(', ')} and synthesises the orientation variants the blockstate does not carry`,
		});
	}

	// 2a2. Whatever still draws nothing, drawn as the block's own item model.
	// This runs after the vendored table so a chest keeps its oriented geometry,
	// and per model reference rather than per block so a case the mod builds in
	// Java (AE2's `formed=true`, MoreRed's wire connections) is filled in while
	// the states with real models keep them.
	const adoptSubstitute = (substitute: ItemModelSubstitute): string => {
		emittedModels[substitute.id] = substitute.emitted;
		modelTintIndices.set(substitute.id, substitute.tintIndices);
		for (const sprite of substitute.sprites) {
			spriteIds.add(sprite);
		}
		return substitute.id;
	};
	for (const [id, references] of blockModels) {
		if (INVISIBLE_BLOCKS[id] !== undefined) {
			continue;
		}
		const empty = references.filter((reference) => {
			const model = emittedModels[reference];
			return model === undefined || (model.elements.length === 0 && !model.mesh?.length);
		});
		if (empty.length === 0) {
			continue;
		}
		const substitute = await itemModelSubstitute(id, resources, models);
		if (substitute === null) {
			continue;
		}
		const definition = definitions.get(id);
		/*
		 * A multipart part draws *as well as* every other part that matches, not instead of one, so
		 * standing an item model in beside parts that already work adds phantom geometry rather than
		 * filling a gap. MoreRed's wire draws its connections from the oriented parts, and the item
		 * model laid over them is a flat cross lying on the floor whichever wall the wire is on.
		 * Dropping the part leaves the block drawing what it can; only code can make the rest.
		 */
		if (definition?.kind === 'multipart') {
			const drawable = definition.cases.filter(part => part.apply.some(variant => !empty.includes(variant.model)));
			if (drawable.length > 0) {
				definition.cases = drawable;
				blockModels.set(id, references.filter(reference => !empty.includes(reference)));
				failures.push({
					id,
					kind: 'geometry',
					reason: `the game draws ${empty.join(', ')} in code; the pack drops those parts rather than laying an unoriented item model over the ${drawable.length} that do draw`,
				});
				continue;
			}
		}
		const stood = adoptSubstitute(substitute);
		for (const part of definition?.cases ?? []) {
			for (const variant of part.apply) {
				if (empty.includes(variant.model)) {
					variant.model = stood;
				}
			}
		}
		blockModels.set(id, [...references.filter(reference => !empty.includes(reference)), stood]);
		const drawnInCode = empty.length === references.length ? 'this block' : empty.join(', ');
		failures.push({
			id,
			kind: 'geometry',
			reason: `the game draws ${drawnInCode} in code; the pack substitutes the block's own item model ${stood}, which carries the shape but not the orientation or connections`,
		});
	}

	// 2b. Serialize the blockstates against the models that survived, dropping
	// references to models nothing could load (AE2 builds its `*_formed` models
	// in Java, so no file exists to export).
	const blockStates: Record<string, BlockPackBlockState> = {};
	for (const [id, definition] of definitions) {
		const serialized = serializeBlockState(definition, model => emittedModels[model] !== undefined);
		if (serialized === null) {
			failures.push({ id, kind: 'blockstate', reason: 'every case named a model that could not be exported' });
			blockModels.delete(id);
			continue;
		}
		blockStates[id] = serialized;
	}

	// 2c. A block whose blockstate the pack could not read at all still has an
	// item model to stand on. NeoForge lets a mod register a *model type* and name
	// it in a variant instead of a model (`{"": {"type": "enderio:conduit"}}`),
	// which leaves the case unusable and the block absent; AE2 has shipped
	// variants stating no model at all. Either way the block exists in the world
	// and the mod ships an inventory shape for it.
	for (const locator of blockLocators) {
		const id = locator.toString();
		if (blockStates[id] !== undefined || INVISIBLE_BLOCKS[id] !== undefined) {
			continue;
		}
		const substitute = await itemModelSubstitute(id, resources, models);
		if (substitute === null) {
			continue;
		}
		const stood = adoptSubstitute(substitute);
		blockStates[id] = { variants: [{ when: {}, apply: [{ model: stood }] }] };
		blockModels.set(id, [stood]);
		failures.push({
			id,
			kind: 'geometry',
			reason: `no case of this blockstate could be read; the pack substitutes the block's own item model ${stood}, which carries the shape but not the orientation`,
		});
	}

	// 3. Sprites → physical animation frames. The fluid sprites join the set the
	// models named, so a consumer meshing water has pixels to mesh it with.
	for (const namespace of namespaces) {
		for (const locator of await resources.listResources('texture', namespace)) {
			if (FLUID_SUFFIX.test(locator.path)) {
				spriteIds.add(locator.toString());
			}
		}
	}
	for (const extra of EXTRA_FLUID_SPRITES) {
		if (await resources.hasResource('texture', ResourceLocator.parse(extra))) {
			spriteIds.add(extra);
		}
	}
	interface LoadedSprite {
		id: string;
		/** Physical frame index → pixels. */
		frames: Map<number, Texture>;
		sequence: Array<{ frame: number; time: number; }>;
		interpolate: boolean;
	}
	const loaded: LoadedSprite[] = [];
	const missingSprites = new Set<string>();
	done = 0;
	for (const id of [...spriteIds].toSorted((left, right) => left.localeCompare(right))) {
		report('sprites', ++done, spriteIds.size);
		if (id === MISSING_SPRITE) {
			// Synthesized below; no jar ships it.
			continue;
		}
		let animated;
		try {
			animated = await textures.loadAnimated(ResourceLocator.parse(id));
		} catch (err) {
			failures.push({ id, kind: 'sprite', reason: (err as Error).message });
			missingSprites.add(id);
			continue;
		}
		if (!animated) {
			failures.push({ id, kind: 'sprite', reason: 'texture not found' });
			missingSprites.add(id);
			continue;
		}
		const overlong = animated.frameCount > MAX_FRAMES_PER_SPRITE;
		if (overlong) {
			failures.push({
				id,
				kind: 'sprite',
				reason: `${animated.frameCount} frames exceeds the ${MAX_FRAMES_PER_SPRITE} cap; exported static`,
			});
		}
		const starts = overlong ? [0] : animated.frameStartTicks();
		const total = overlong ? 1 : animated.tickLength;
		const sequence = starts.map((start, index) => {
			return {
				frame: animated.resolveFrame(start).frame,
				time: (index + 1 < starts.length ? starts[index + 1] : total) - start,
			};
		});
		const frames = new Map<number, Texture>();
		for (const entry of sequence) {
			if (!frames.has(entry.frame)) {
				frames.set(entry.frame, animated.frame(entry.frame));
			}
		}
		loaded.push({ id, frames, sequence, interpolate: animated.interpolated });
	}

	// Always packed, even where nothing resolved to it: it is what a consumer
	// draws for a block this pack does not describe at all — a mod that is
	// loaded on the server but whose pack was never fetched — and a guarantee
	// is worth more to that consumer than the 256 pixels it costs.
	spriteIds.add(MISSING_SPRITE);
	loaded.push({
		id: MISSING_SPRITE,
		frames: new Map([[0, missingTexture()]]),
		sequence: [{ frame: 0, time: 1 }],
		interpolate: false,
	});

	// 4. Pack.
	const packed = packAtlas(
		loaded.flatMap(sprite => [...sprite.frames].map(([index, texture]) => {
			return { key: `${sprite.id}#${index}`, texture };
		})),
		{ padding: options.padding, maxPageSize: options.maxPageSize },
	);
	// A sprite that does not fit a page gets no rect, so it joins the missing set
	// rather than leaving models naming an id atlas.json has no entry for.
	for (const key of packed.oversized) {
		const id = key.split('#', 1)[0];
		// Every frame of an animated sprite is the same size, so report once.
		if (!missingSprites.has(id)) {
			failures.push({ id, kind: 'sprite', reason: 'sprite is larger than one atlas page; drawn as the missing texture' });
			missingSprites.add(id);
		}
	}
	if (missingSprites.has(MISSING_SPRITE)) {
		throw new Error('the missing-texture sprite does not fit an atlas page; maxPageSize is too small');
	}

	// A face whose sprite never loaded, or never fit a page, points at the
	// missing-texture sprite, the same as the game does — dropping it would leave
	// a hole in geometry the player can see. Already reported above.
	if (missingSprites.size > 0) {
		for (const model of Object.values(emittedModels)) {
			for (const element of model.elements) {
				for (const face of Object.values(element.faces)) {
					if (missingSprites.has(face.sprite)) {
						face.sprite = MISSING_SPRITE;
					}
				}
			}
			for (const group of model.mesh ?? []) {
				if (missingSprites.has(group.sprite)) {
					group.sprite = MISSING_SPRITE;
				}
			}
			if (model.particle !== undefined && missingSprites.has(model.particle)) {
				model.particle = MISSING_SPRITE;
			}
		}
	}
	for (const [id, model] of Object.entries(emittedModels)) {
		// A model drawn entirely in missing-texture is one the mod broke: Ars
		// Nouveau's alteration table binds no variable its faces name. Worth
		// saying once per model, so a consumer can hide the block rather than
		// show a magenta box, without scanning every face to find out.
		const sprites = [
			...model.elements.flatMap(element => Object.values(element.faces).map(face => face.sprite)),
			...(model.mesh ?? []).map(group => group.sprite),
		];
		if (sprites.length > 0 && sprites.every(sprite => sprite === MISSING_SPRITE)) {
			failures.push({ id, kind: 'texture', reason: 'every face uses the missing-texture sprite; the model binds none of the textures it names' });
		}
		if (model.elements.length === 0 && !model.mesh?.length) {
			// Fluids, air, and blocks a mod draws entirely in code. Not a failure to
			// export — but the consumer has to know it is getting nothing to draw.
			failures.push({ id, kind: 'geometry', reason: 'model has no drawable elements' });
		}
	}

	const rects = new Map(packed.rects.map(rect => [rect.key, rect]));
	const emittedSprites: Record<string, BlockPackSprite> = {};
	for (const sprite of loaded) {
		const first = rects.get(`${sprite.id}#${sprite.sequence[0].frame}`);
		if (!first) {
			continue;
		}
		const frames: BlockPackSpriteFrame[] = [];
		for (const entry of sprite.sequence) {
			const rect = rects.get(`${sprite.id}#${entry.frame}`);
			if (rect) {
				frames.push({ page: rect.page, x: rect.x, y: rect.y, time: entry.time });
			}
		}
		emittedSprites[sprite.id] = {
			page: first.page,
			x: first.x,
			y: first.y,
			w: first.width,
			h: first.height,
			layer: inferRenderLayer(sprite.frames.values().toArray()),
			...(frames.length === sprite.sequence.length && frames.length > 1 && { frames }),
			...(sprite.interpolate && { interpolate: true as const }),
		};
	}

	// 5. Tints, and every tintindex nothing states a meaning for.
	const tints = await buildBlockTints(resources, textures);
	for (const [block, references] of blockModels) {
		const used = new Set<number>();
		for (const reference of references) {
			for (const index of modelTintIndices.get(reference) ?? []) {
				used.add(index);
			}
		}
		for (const index of used) {
			if (tints.pack.blocks[block]?.[String(index)] === undefined) {
				// Not automatically a defect: vanilla leaves an unregistered
				// tintindex untinted too (cherry leaves inherit one from
				// block/leaves and are meant to stay pink). Recorded so a real
				// gap in the table is visible instead of just looking grey.
				failures.push({ id: block, kind: 'tint', reason: `tintindex ${index} is not in the tint table; exported untinted` });
			}
		}
	}

	// 6. Emit.
	await mkdir(output, { recursive: true });
	const hashes: Record<string, string> = {};
	let writtenFiles = 0;
	const emit = async (file: string, data: Buffer | string): Promise<void> => {
		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
		const target = path.join(output, file);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, buffer);
		hashes[file] = createHash('sha256').update(buffer).digest('hex');
		writtenFiles++;
	};

	const pageFiles: Array<{ file: string; width: number; height: number; }> = [];
	for (const [index, page] of packed.pages.entries()) {
		const file = `atlas-${index}.png`;
		const raw = Buffer.from(page.data.buffer, page.data.byteOffset, page.data.byteLength);
		await emit(file, await sharp(raw, { raw: { width: page.width, height: page.height, channels: 4 } })
			.png({ compressionLevel: 9 })
			.toBuffer());
		pageFiles.push({ file, width: page.width, height: page.height });
	}
	for (const file of tints.files) {
		await emit(file.path, file.data);
	}
	await emit('atlas.json', JSON.stringify({
		padding: packed.padding,
		pages: pageFiles,
		sprites: sortedByKey(emittedSprites),
	} satisfies BlockPackAtlasFile));
	await emit('models.json', JSON.stringify(sortedByKey(emittedModels) satisfies BlockPackModelsFile));
	await emit('blockstates.json', JSON.stringify(sortedByKey(blockStates) satisfies BlockPackBlockStatesFile));
	await emit('tints.json', JSON.stringify(tints.pack satisfies BlockPackTintsFile));
	failures.sort((left, right) => left.id.localeCompare(right.id) || left.kind.localeCompare(right.kind));
	await emit('failures.json', JSON.stringify(failures, null, '\t'));

	const counts = {
		blocks: Object.keys(blockStates).length,
		models: Object.keys(emittedModels).length,
		sprites: Object.keys(emittedSprites).length,
		pages: packed.pages.length,
		failures: failures.length,
	};
	// meta.json hashes the pack, so it is written last and hashes nothing of itself.
	await emit('meta.json', JSON.stringify({
		generator: 'rendermite',
		version,
		namespaces,
		counts,
		hashes: sortedByKey(hashes),
	} satisfies BlockPackMetaFile, null, '\t'));
	return { ...counts, writtenFiles, failures };
}
