import { LruCache } from '../resources/cache.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type {
	DisplayPosition,
	DisplayTransformJson,
	FaceDirectionName,
	ModelElementJson,
	ModelJson,
} from './types.ts';
import type { ResourceManager } from '../resources/manager.ts';

/**
 * A model with its parent chain flattened: textures merged child-over-parent,
 * elements taken from the deepest model that defines any, display transforms
 * merged per position.
 */
export interface ResolvedModel {
	locator: ResourceLocator;
	/** `builtin/generated` etc. — the terminal builtin parent, when the chain ends in one. */
	builtinParent: string | null;
	/**
	 * `ambientocclusion`, nearest declaration in the chain wins. Only the block
	 * pack reads it; the icon renderer has no ambient occlusion to switch off.
	 */
	ambientOcclusion: boolean;
	guiLight: 'front' | 'side';
	/**
	 * The gui_light in effect when `elements` were defined in the chain — upstream
	 * elements capture their light source at construction, so a descendant that
	 * overrides gui_light without redefining elements does not relight them.
	 */
	elementsGuiLight: 'front' | 'side';
	display: Partial<Record<DisplayPosition, DisplayTransformJson>>;
	/** Texture variables fully merged (values may still be `#refs` until resolveTexture). */
	textures: Record<string, string>;
	elements: ModelElementJson[];
	/** Deepest-first chain of model locators, for diagnostics. */
	chain: string[];
	/**
	 * `render_type` as the chain states it, namespace stripped. Authoritative
	 * where present; nothing states it in vanilla.
	 */
	renderType: string | null;
	/** Forge/NeoForge OBJ loader geometry reference, when the chain declares one. */
	obj?: { model: string; flipV: boolean; objects?: string[]; conditional?: boolean; };
	/**
	 * Block offsets a split-multiblock model spans. IE's `basic_split` wraps one
	 * mesh covering several blocks and hands each position its own slice at
	 * runtime; which slice is in the block entity, not in the assets.
	 */
	splitParts?: Array<[number, number, number]>;
	/** Fluid id from a fluid_container loader, for painting bucket contents. */
	fluid?: string;
}

export class ModelResolutionError extends Error {}

/** Override redirects to follow before giving up; cycles are the reason. */
const MAX_OVERRIDE_REDIRECTS = 4;

const MAX_PARENT_DEPTH = 64;
const MAX_TEXTURE_REF_DEPTH = 16;

/** Forge's generated-item aliases are injected by the loader, not shipped as resources. */
const MODEL_PARENT_ALIASES: Readonly<Record<string, string>> = {
	'forge:item/default': 'minecraft:item/generated',
	'forge:item/default-tool': 'minecraft:item/handheld',
	// The loaders register these themselves, so they exist in no jar we read.
	// Blockbench writes `neoforge:block/default` into every block it exports,
	// which stranded whole mods (pneumaticcraft) on a missing parent.
	'forge:block/default': 'minecraft:block/block',
	'neoforge:block/default': 'minecraft:block/block',
	'neoforge:item/default': 'minecraft:item/generated',
	'neoforge:item/default-tool': 'minecraft:item/handheld',
};

/**
 * Per-mod synthesizers for loaders whose geometry lives entirely in Java but
 * whose icon shape is simple and stable enough to rebuild from the model json.
 * Keyed on the EXACT loader id so an unknown mod's loader never gets a wrong
 * guess — unhandled loaders keep the strip-and-fail-loud path below, and the
 * run() fallback chain (block model, geo, entity, sprite) still applies.
 * Adding a mod means adding an entry here plus a fixture test.
 */
const MOD_LOADER_HANDLERS: Record<string, (json: ModelJson) => ModelJson> = {
	'immersiveengineering:conf_sides': flattenConfSides,
	'immersiveengineering:basic_split': flattenSplitMultiblock,
	'immersiveengineering:ie_obj': restrictIeObjParts,
	'mekanism:energy_cube': flattenEnergyCube,
	'mekanism:transmitter': restrictTransmitterToUnconnected,
	'botania:floating_flower': composeFloatingFlower,
	'tconstruct:tool': layerToolParts,
	'modern_industrialization:machine': composeMachine,
	'modern_industrialization:use_block_model': imitateBlockModel,
	'sophisticatedstorage:barrel': flattenStorageBarrel,
	'sophisticatedstorage:limited_barrel': flattenStorageBarrel,
	'sophisticatedstorage:simple_composite': mergeCompositeParts,
	'morered:wire_parts': restrictWireToCentre,
	// IE addons (Immersive Petroleum etc.) register conveyor types through
	// IE's API, so their items also carry IE's loader id.
	'immersiveengineering:models/conveyor': flattenConveyor,
};

/**
 * Rewrite custom-loader models (forge/neoforge `loader` key) into drawable
 * geometry. Left unhandled they fall back to a textureless parent and render
 * as black squares — worse than failing, since the item still counts as having
 * an icon (1,793 such icons in the old pipeline's modded run). Resolution
 * order mirrors what each loader actually draws: the gui perspective IS the
 * icon view; composite children draw first-to-last; fluid containers' real
 * parent is loader-provided with no file behind it. OBJ loaders are left
 * alone — their geometry is a different file format.
 */
export function flattenLoaderModel(json: ModelJson, depth = 0): ModelJson {
	const loader = extractLoaderType(json);
	// Nested loader models bottom out fast in practice; the depth cap only
	// guards against adversarial jars.
	if (!loader || depth > 8) {
		return json;
	}
	// OBJ geometry is handled by the renderer; normalize the reference here. A
	// mod loader that is not named `obj` but states the OBJ loader's own
	// `model`/`flip_v` keys pointing at an OBJ path is one too — Mekanism's
	// transmitter loader wraps `…/transmitter_small.obj.mek` exactly that way.
	const objCandidate = json as ModelJson & { model?: string; flip_v?: boolean; flip_V?: boolean; };
	const objReference = typeof objCandidate.model === 'string'
		&& (/obj$/i.test(loader) || /\.obj(?:$|\.)/i.test(objCandidate.model))
		? objCandidate.model
		: null;
	if (objReference !== null) {
		const marked = withoutLoader(json) as ModelJson & { objModel?: { model: string; flipV: boolean; objects?: string[]; }; };
		marked.objModel = {
			model: objReference,
			flipV: objCandidate.flip_v ?? objCandidate.flip_V ?? false,
		};
		delete (marked as { model?: string; }).model;
		// A mod loader wrapping an OBJ may still need to narrow it down.
		const objHandler = MOD_LOADER_HANDLERS[loader];
		return objHandler ? objHandler(marked) : marked;
	}
	if (/obj$/i.test(loader)) {
		return json;
	}
	const handler = MOD_LOADER_HANDLERS[loader];
	if (handler) {
		return handler(json);
	}
	const extended = json as ModelJson & {
		perspectives?: { gui?: ModelJson; };
		base?: ModelJson;
		childModel?: string;
		delegate?: string;
		children?: Record<string, ModelJson | string>;
		inner_model?: ModelJson;
	};
	// Nested models can themselves be loader models (IE composites hold OBJ
	// children), so every object branch re-flattens recursively.
	if (extended.perspectives?.gui && typeof extended.perspectives.gui === 'object') {
		return flattenLoaderModel(extended.perspectives.gui, depth + 1);
	}
	if (extended.base && typeof extended.base === 'object') {
		return flattenLoaderModel(extended.base, depth + 1);
	}
	if (typeof extended.childModel === 'string') {
		return { parent: extended.childModel };
	}
	// A loader that wraps one other model by name (MI's pipes all delegate to
	// block/pipe) is a parent redirect with extra runtime behaviour attached.
	if (typeof extended.delegate === 'string') {
		return { parent: extended.delegate };
	}
	// The same shape under the loader's own spelling. `model` only reaches here
	// when the OBJ branch above declined it, so it names a JSON model —
	// Supplementaries' faucet points at block/faucet_model this way — and the
	// wrapper's own textures still bind the delegate's variables.
	if (typeof objCandidate.model === 'string') {
		const redirected = { ...withoutLoader(json), parent: objCandidate.model } as ModelJson & { model?: string; };
		delete redirected.model;
		return redirected;
	}
	if (extended.children && typeof extended.children === 'object') {
		const children = Object.values(extended.children);
		const inline = children.filter((child): child is ModelJson => typeof child === 'object' && child !== null);
		// Composites draw every child; inline element children merge into one
		// model (mekanism's industrial_alarm splits solid + translucent parts),
		// keeping the composite's own display/gui_light/textures.
		if (inline.length > 0 && inline.every(child => Array.isArray((child as ModelJson).elements))) {
			return {
				...withoutLoader(json),
				children: undefined,
				textures: Object.assign({}, ...inline.map(child => child.textures), json.textures),
				elements: inline.flatMap(child => child.elements ?? []),
			} as ModelJson;
		}
		const first = children[0];
		if (typeof first === 'string') {
			return { parent: first };
		}
		if (first && typeof first === 'object') {
			return flattenLoaderModel(first, depth + 1);
		}
	}
	// IE's split multiblocks wrap the drawable model as inner_model.
	if (extended.inner_model && typeof extended.inner_model === 'object') {
		return flattenLoaderModel(extended.inner_model, depth + 1);
	}
	// A loader that nests one whole model under a key of its own naming
	// (architects_palette:wrapped uses `wrapped_model`) is that model with runtime
	// behaviour attached, so the nested one is what draws. Only a value carrying
	// `parent` or `elements` qualifies, which no `display` or `textures` map does.
	for (const value of Object.values(json)) {
		const nested = value as ModelJson | null;
		if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
			continue;
		}
		if (nested.parent !== undefined || Array.isArray(nested.elements)) {
			return flattenLoaderModel(nested, depth + 1);
		}
	}
	if (/fluid_container|bucket/i.test(loader)) {
		// The declared parent is usually forge:item/bucket, which exists in no
		// jar we load — rebase onto the vanilla bucket and keep the fluid id so
		// the renderer can paint the contents.
		const fluid = (json as ModelJson & { fluid?: string; }).fluid;
		const bucket = { parent: 'minecraft:item/bucket' } as ModelJson & { fluidContained?: string; };
		if (typeof fluid === 'string' && fluid.length > 0 && !fluid.endsWith(':empty')) {
			bucket.fluidContained = fluid;
		}
		return bucket;
	}
	// Unflattenable (code-built geometry): strip the loader and let the declared
	// parent/textures decide; a missing layer0 then fails loudly instead of black.
	// A loader that names its one sprite `texture` rather than `layer0` is the
	// exception — Tinkers' material loader tints that sprite per material, and
	// the untinted sprite is a far better icon than no icon at all.
	const stripped = withoutLoader(json);
	const sprite = stripped.textures?.texture;
	if (typeof sprite === 'string' && stripped.textures?.layer0 === undefined) {
		return { ...stripped, textures: { ...stripped.textures, layer0: sprite } };
	}
	return stripped;
}

/** IE conveyor types whose belt texture is not simply `block/conveyor/<type>`. */
const CONVEYOR_BELTS: Record<string, string> = {
	basic: 'conveyor',
	covered: 'conveyor',
	extract: 'conveyor',
	splitter: 'split',
};

/**
 * IE's conveyor loader builds its belt entirely in code, but the shape it
 * draws for the icon is just a flat 16x2x16 belt with the type's (animated)
 * belt texture on top. The display transform is inlined because the model
 * json has no block/block parent to inherit the gui pose from.
 */
function flattenConveyor(json: ModelJson): ModelJson {
	const conveyorType = (json as ModelJson & { conveyorType?: string; }).conveyorType;
	if (typeof conveyorType !== 'string' || !conveyorType.includes(':')) {
		return withoutLoader(json);
	}
	const [namespace, type] = conveyorType.split(':', 2);
	const belt = `${namespace}:block/conveyor/${CONVEYOR_BELTS[type] ?? type}`;
	const side = { uv: [0, 0, 16, 2] as [number, number, number, number], texture: '#belt' };
	return {
		gui_light: 'side',
		display: { gui: { rotation: [30, 225, 0], translation: [0, 0, 0], scale: [0.625, 0.625, 0.625] } },
		textures: { belt, particle: belt },
		elements: [{
			from: [0, 0, 0],
			to: [16, 2, 16],
			faces: {
				up: { uv: [0, 0, 16, 16], texture: '#belt' },
				down: { uv: [0, 0, 16, 16], texture: '#belt' },
				north: side,
				south: side,
				east: side,
				west: side,
			},
		}],
	};
}

/**
 * IE's `ie_obj` loader packs several states of a block into one OBJ as named
 * objects and picks between them in a Java callback: a workbench draws its
 * blueprint only when one is inserted, a post grows arms only toward
 * neighbours, a logic unit shows a board per installed circuit. The model files
 * name the callback and nothing else, so the placed-and-empty default is
 * curated here per callback.
 *
 * Only callbacks whose default is unambiguous are listed — the rest keep
 * drawing every object, and the block pack records that they did rather than
 * substituting a guess.
 */
const IE_DEFAULT_PARTS: Readonly<Record<string, string[]>> = {
	'immersiveengineering:workbench': ['cube0'],
	'immersiveengineering:post': ['base'],
	'immersiveengineering:lantern': ['base'],
	'immersiveengineering:logic_unit': ['base', 'tubes'],
};

function restrictIeObjParts(json: ModelJson): ModelJson {
	const marked = json as ModelJson & {
		callbacks?: unknown;
		objModel?: { model: string; flipV: boolean; objects?: string[]; conditional?: boolean; };
	};
	if (typeof marked.callbacks !== 'string' || !marked.objModel) {
		return marked;
	}
	const parts = IE_DEFAULT_PARTS[marked.callbacks];
	if (parts) {
		marked.objModel.objects = parts;
	} else {
		// A callback with no curated default still picks a subset at runtime;
		// flag it so the pack can say the mesh holds states it drew together.
		marked.objModel.conditional = true;
	}
	return marked;
}

/**
 * IE's split loader wraps one model spanning several blocks — a coke oven's
 * mesh is the whole 2x2x2 structure — and gives each block position its own
 * slice of it at draw time. Which slice is in the block entity rather than in
 * the assets, so the part list is carried through instead: a consumer can draw
 * the mesh once from the structure's corner rather than once per position.
 */
function flattenSplitMultiblock(json: ModelJson): ModelJson {
	const extended = json as ModelJson & { inner_model?: ModelJson; split_parts?: unknown; };
	const inner = extended.inner_model && typeof extended.inner_model === 'object'
		? flattenLoaderModel(extended.inner_model, 1)
		: withoutLoader(json);
	const parts = Array.isArray(extended.split_parts)
		? extended.split_parts.filter((part): part is [number, number, number] => Array.isArray(part) && part.length === 3)
		: [];
	return parts.length > 0 ? { ...inner, splitParts: parts } as ModelJson : inner;
}

/**
 * IE's conf_sides loader picks per-face textures from `<base_name>` plus a
 * side/io suffix at runtime; the icon always shows the unconfigured ("none")
 * state, so a plain cube with those textures matches what the game draws.
 */
function flattenConfSides(json: ModelJson): ModelJson {
	const { type, base_name: base } = json as ModelJson & { type?: string; base_name?: string; };
	if (typeof base !== 'string') {
		return withoutLoader(json);
	}
	const faces = type === 'side_top_bottom'
		? { up: `${base}_up_none`, down: `${base}_down_none`, side: `${base}_side_none` }
		: (type === 'vertical'
			? { up: `${base}_up_none`, down: `${base}_up_none`, side: `${base}_side` }
			: { up: `${base}_side_none`, down: `${base}_side_none`, side: `${base}_side_none` });
	return {
		parent: 'minecraft:block/cube',
		textures: {
			particle: faces.side,
			up: faces.up,
			down: faces.down,
			north: faces.side,
			south: faces.side,
			east: faces.side,
			west: faces.side,
		},
	};
}

/**
 * Mekanism's energy_cube loader keeps the body under `frame` and each side's
 * connector and indicator under `<side>Port`/`<side>LEDs`, picking which sides
 * show at runtime from the stack's stored side config. Every group is emitted:
 * a cube with all its ports is what a configured cube looks like, and dropping
 * them would leave the six faces blank.
 */
function flattenEnergyCube(json: ModelJson): ModelJson {
	const groups = json as ModelJson & Record<string, unknown>;
	const elements = Object.entries(groups)
		.filter(([name, value]) => (name === 'frame' || /(?:Port|LEDs)$/.test(name)) && Array.isArray(value))
		.flatMap(([, value]) => value as ModelElementJson[]);
	if (elements.length === 0) {
		return withoutLoader(json);
	}
	return { ...withoutLoader(json), elements };
}

/**
 * Mekanism's transmitter loader wraps one OBJ holding every connection state of
 * a cable — each direction appears as `<direction>NONE`, `NORMAL`, `PUSH` and
 * `PULL` objects, and the loader picks one per side from the neighbouring
 * blocks. An item has no neighbours, so every side is NONE; drawing the lot
 * gives a spiked ball of overlapping states.
 */
function restrictTransmitterToUnconnected(json: ModelJson): ModelJson {
	const marked = json as ModelJson & { objModel?: { model: string; flipV: boolean; objects?: string[]; }; };
	if (marked.objModel) {
		marked.objModel.objects = ['down', 'up', 'north', 'south', 'east', 'west'].map(side => `${side}NONE`);
	}
	return marked;
}

/**
 * MoreRed's wire loader holds the two shapes a wire draws *between* blocks
 * (`line` across a face, `edge` around its corner) and picks per connection from
 * the block entity. Neither is the wire itself: the blockstate places the centre
 * separately, and an unconnected wire is only that centre. Taking one of the two,
 * whichever the file happens to name first, put a stub in a corner of every wire
 * in the world, so the loader draws nothing here and the block pack falls back to
 * the mod's own item model, which is the wire's full cross.
 */
function restrictWireToCentre(json: ModelJson): ModelJson {
	const stripped = withoutLoader(json) as ModelJson & { line?: unknown; edge?: unknown; };
	delete stripped.line;
	delete stripped.edge;
	return { ...stripped, elements: [] };
}

/**
 * Botania's floating flowers are a mystical island with a flower planted on it:
 * the loader draws `botania:block/islands/island_<type>` under the model named
 * by the `flower` key. The island type is stored per block and defaults to
 * GRASS, which is what a freshly crafted one — and so the item — shows.
 */
function composeFloatingFlower(json: ModelJson): ModelJson {
	const flower = (json as ModelJson & { flower?: ModelJson; }).flower;
	const merges = ['botania:block/islands/island_grass'];
	if (typeof flower?.parent === 'string') {
		merges.push(flower.parent);
	}
	const composed = { ...withoutLoader(json), mergeModels: merges } as ModelJson & { flower?: ModelJson; };
	delete composed.flower;
	return composed;
}

/**
 * Tinkers' tool loader stacks one sprite per tool part — head, handle, binding
 * and so on — tinting each by the material it was built from. The parts are
 * declared in draw order, so laying them out as layer0..layerN reproduces the
 * uncoloured tool. `large_*` duplicates are the broad-tool variants the item
 * icon never uses, and `modifier_roots` are overlays for applied modifiers.
 */
function layerToolParts(json: ModelJson): ModelJson {
	const stripped = withoutLoader(json);
	const parts = Object.entries(stripped.textures ?? {})
		.filter(([name]) => !name.startsWith('large_') && name !== 'particle' && !/^layer\d+$/.test(name));
	if (parts.length === 0) {
		return stripped;
	}
	const layers = Object.fromEntries(parts.map(([, value], index) => [`layer${index}`, value]));
	return { ...stripped, parent: 'minecraft:item/generated', textures: { ...stripped.textures, ...layers } };
}

/**
 * A casing that borrows another block's look states only the block id. Its
 * model is that block's, under the conventional block/<path> name — which is
 * where every casing MI does this for actually keeps it.
 */
function imitateBlockModel(json: ModelJson): ModelJson {
	const block = (json as ModelJson & { block?: unknown; }).block;
	if (typeof block !== 'string') {
		return withoutLoader(json);
	}
	const locator = ResourceLocator.tryParse(block);
	return locator === null
		? withoutLoader(json)
		: { parent: `${locator.namespace}:block/${locator.path}` };
}

/**
 * Which face each of MI's machine overlays belongs on. The rest of the
 * vocabulary — `*_active`, `output`, `item_auto`, `fluid_auto` — is runtime
 * state (running, or a configured auto-IO side) that a freshly crafted machine
 * does not show, so the icon leaves them off.
 */
const MACHINE_OVERLAY_FACES: Record<string, FaceDirectionName[]> = {
	front: ['north'],
	top: ['up'],
	bottom: ['down'],
	side: ['east', 'west', 'south'],
};

/**
 * MI machines are a casing block wearing per-face overlays. The casing is named
 * rather than inlined (`"casing": "lv"` ↔ machine_casing/lv), and the overlays
 * are full texture ids, so the model becomes the casing merged in underneath a
 * hair-inflated cube carrying the overlay faces.
 */
function composeMachine(json: ModelJson): ModelJson {
	const extended = json as ModelJson & { casing?: unknown; default_overlays?: Record<string, unknown>; };
	const casing = typeof extended.casing === 'string' ? extended.casing : null;
	const overlays = extended.default_overlays ?? {};
	const textures: Record<string, string> = {};
	const faces: ModelElementJson['faces'] = {};
	for (const [name, directions] of Object.entries(MACHINE_OVERLAY_FACES)) {
		const texture = overlays[name];
		if (typeof texture !== 'string') {
			continue;
		}
		textures[name] = texture;
		for (const direction of directions) {
			faces[direction] = { texture: `#${name}` };
		}
	}
	// A hair outside the casing so the overlay wins the depth test cleanly.
	const elements: ModelElementJson[] = Object.keys(faces).length > 0
		? [{ from: [-0.01, -0.01, -0.01], to: [16.01, 16.01, 16.01], faces }]
		: [];
	return {
		parent: 'minecraft:block/block',
		textures,
		elements,
		...(casing !== null && { mergeModels: [`modern_industrialization:machine_casing/${casing}`] }),
	} as ModelJson;
}

/**
 * Sophisticated Storage composes its barrels from part models with two levels of
 * texture indirection, but the tier part states the three textures a barrel
 * actually wears under vanilla's own `top`/`side`/`bottom` names. Those names
 * belong to `cube_bottom_top`, which is the shape a barrel is — the parts the
 * loader adds on top are trim and the tintable core.
 */
function flattenStorageBarrel(json: ModelJson): ModelJson {
	const extended = json as ModelJson & {
		model_parts?: Record<string, { model?: string; textures?: Record<string, string>; }>;
		partitioned_model_parts?: Record<string, { model?: string; textures?: Record<string, string>; }>;
	};
	const groups = [extended.partitioned_model_parts, extended.model_parts];
	// A part states a shape, textures for the shape below it, or both. The tier
	// textures are trim overlays rather than whole faces, so they have to land on
	// the body the parts draw rather than on a bare cube.
	const textures: Record<string, string> = {};
	const merges: string[] = [];
	// Only the shapes a barrel wears as placed. The two part groups are the
	// partitioned and plain variants of the same barrel, and within a group
	// `_open`, `locked` and `packed` are states — merging the lot stacked
	// barrel_part/base four times over, 114 elements for a box.
	const shapes = extended.model_parts ?? extended.partitioned_model_parts ?? {};
	for (const [name, part] of Object.entries(shapes)) {
		if (typeof part.model === 'string' && !/_open$|^locked$|^packed$/.test(name) && !merges.includes(part.model)) {
			merges.push(part.model);
		}
	}
	for (const group of groups) {
		for (const part of Object.values(group ?? {})) {
			Object.assign(textures, part.textures);
		}
	}
	const flattened = withoutLoader(json) as ModelJson & Record<string, unknown>;
	delete flattened.model_parts;
	delete flattened.partitioned_model_parts;
	delete flattened.dynamic_part_models;
	delete flattened.wood_overrides;
	return {
		...flattened,
		// The root barrel model declares no parent at all, so nothing in the chain
		// would supply a gui pose and the icon would fill the frame flat-on.
		parent: flattened.parent ?? 'minecraft:block/block',
		textures: { ...flattened.textures, ...textures },
		...((merges.length > 0) && { mergeModels: merges }),
	} as ModelJson;
}

/**
 * A composite whose parts are named parent references rather than inline
 * geometry — every part is drawn, so they all merge in.
 */
function mergeCompositeParts(json: ModelJson): ModelJson {
	const parts = (json as ModelJson & { parts?: Record<string, { parent?: string; }>; }).parts ?? {};
	const merges = Object.values(parts)
		.map(part => part.parent)
		.filter((parent): parent is string => typeof parent === 'string');
	return merges.length === 0
		? withoutLoader(json)
		: { ...withoutLoader(json), parts: undefined, mergeModels: merges } as ModelJson;
}

function extractLoaderType(json: ModelJson): string | null {
	const record = json as { loader?: unknown; };
	if (typeof record.loader === 'string') {
		return record.loader;
	}
	// NeoForge 1.21+ nests it: {"loader": {"type": "..."}} in some mods.
	if (typeof record.loader === 'object' && record.loader !== null) {
		const type = (record.loader as { type?: unknown; }).type;
		return typeof type === 'string' ? type : null;
	}
	return null;
}

function withoutLoader(json: ModelJson): ModelJson {
	const rest = { ...json } as ModelJson & { loader?: unknown; };
	delete rest.loader;
	return rest;
}

function needsNormalizing(element: ModelElementJson): boolean {
	return typeof element.extra_rotation === 'number' && element.extra_rotation !== 0 && element.rotation !== undefined;
}

/**
 * Fold `extra_rotation` into the element's own rotation. Supplementaries slants
 * its awnings with it — an arbitrary angle past vanilla's 22.5 steps, written
 * beside a `rotation` of angle 0 — and ignoring it silently flattens them.
 *
 * The untouched array is returned by identity, so children of a shared parent
 * keep sharing one elements array rather than each holding a copy.
 */
function normalizeElements(elements: ModelElementJson[]): ModelElementJson[] {
	if (!elements.some(element => needsNormalizing(element))) {
		return elements;
	}
	return elements.map((element) => {
		if (!needsNormalizing(element) || !element.rotation) {
			return element;
		}
		const angle = (element.rotation.angle ?? 0) + (element.extra_rotation ?? 0);
		return { ...element, rotation: { ...element.rotation, angle } };
	});
}

function isBuiltinParent(parent: string): boolean {
	return parent.startsWith('builtin/') || parent.startsWith('minecraft:builtin/');
}

function normalizeBuiltin(parent: string): string {
	return parent.replace(/^minecraft:/, '');
}

/**
 * Return the first complete JSON value in a string, tolerating trailing junk the way
 * Gson does (IntegratedDynamics ships models with garbage after the closing brace).
 * Returns null when no complete value exists.
 */
export function salvageJson(text: string): unknown | null {
	const start = text.search(/[[{]/);
	if (start === -1) {
		return null;
	}
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const char = text[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === '\\') {
				escaped = true;
			} else if (char === '"') {
				inString = false;
			}
			continue;
		}
		if (char === '"') {
			inString = true;
		} else if (char === '{' || char === '[') {
			depth++;
		} else if (char === '}' || char === ']') {
			depth--;
			if (depth === 0) {
				try {
					return JSON.parse(text.slice(start, i + 1));
				} catch {
					return null;
				}
			}
		}
	}
	return null;
}

/**
 * Resolved models and their source JSON are small but there are a lot of them:
 * a full modded run walks thousands of namespaces in one process, so the caches
 * are bounded rather than kept for the life of the run.
 */
const MAX_CACHED_MODELS = 4096;

export class ModelLoader {
	private readonly resources: ResourceManager;
	private readonly cache: LruCache<string, Promise<ResolvedModel>>;
	private readonly jsonCache: LruCache<string, Promise<ModelJson>>;

	constructor(resources: ResourceManager, maxCachedModels = MAX_CACHED_MODELS) {
		this.resources = resources;
		this.cache = new LruCache(maxCachedModels);
		this.jsonCache = new LruCache(maxCachedModels);
	}

	private readModelJson(locator: ResourceLocator): Promise<ModelJson> {
		const key = locator.toString();
		let pending = this.jsonCache.get(key);
		if (!pending) {
			pending = this.loadModelJson(locator);
			this.jsonCache.set(key, pending);
		}
		return pending;
	}

	private async loadModelJson(locator: ResourceLocator): Promise<ModelJson> {
		const raw = await this.resources.getResource('model', locator);
		if (raw === null) {
			throw new ModelResolutionError(`Model not found: ${locator}`);
		}
		let json: ModelJson;
		try {
			json = JSON.parse(raw.toString('utf8')) as ModelJson;
		} catch {
			// Mods ship JSON with trailing junk that the game's parser (Gson) tolerates;
			// salvage the first complete value rather than losing the item.
			const salvaged = salvageJson(raw.toString('utf8'));
			if (salvaged === null) {
				throw new ModelResolutionError(`Model is not valid JSON: ${locator}`);
			}
			json = salvaged as ModelJson;
		}
		return flattenLoaderModel(json);
	}

	private async resolve(locator: ResourceLocator, overrideDepth = 0): Promise<ResolvedModel> {
		// Walk root-ward collecting the chain, deepest (requested) model first.
		const chain: Array<{ locator: ResourceLocator; json: ModelJson; }> = [];
		const seen = new Set<string>();
		let current: ResourceLocator | null = locator;
		let builtinParent: string | null = null;

		while (current !== null) {
			const key: string = current.toString();
			if (seen.has(key)) {
				throw new ModelResolutionError(`Model parent cycle at ${key} (from ${locator})`);
			}
			if (chain.length >= MAX_PARENT_DEPTH) {
				throw new ModelResolutionError(`Model parent chain exceeds ${MAX_PARENT_DEPTH} at ${locator}`);
			}
			seen.add(key);
			let json: ModelJson;
			try {
				json = await this.readModelJson(current);
			} catch (err) {
				// The model asked for itself must exist; a PARENT that does not is
				// survivable. Blockbench writes stray bare parents — heralds_luna's
				// 5,000 banners all inherit `"parent": "flag"`, which resolves to a
				// `minecraft:flag` nothing ships — while carrying their own elements,
				// textures and display. Treating the missing link as the end of the
				// chain draws them; a model that really needed the parent still has
				// nothing to draw and fails on the drawability checks below, so this
				// can substitute a blank icon for a loud error but never a wrong one.
				if (chain.length === 0 || !(err instanceof ModelResolutionError)) {
					throw err;
				}
				break;
			}
			chain.push({ locator: current, json });
			if (json.parent === undefined) {
				current = null;
			} else if (isBuiltinParent(json.parent)) {
				builtinParent = normalizeBuiltin(json.parent);
				current = null;
			} else {
				current = ResourceLocator.parse(MODEL_PARENT_ALIASES[json.parent] ?? json.parent);
			}
		}

		// Merge root-ward entries first so children override parents, mirroring how
		// upstream applies the chain onto one Model object.
		const textures: Record<string, string> = {};
		const display: Partial<Record<DisplayPosition, DisplayTransformJson>> = {};
		let elements: ModelElementJson[] = [];
		let guiLight: 'front' | 'side' | undefined;
		let elementsGuiLight: 'front' | 'side' | undefined;
		let ambientOcclusion: boolean | undefined;
		let renderType: string | undefined;
		for (let i = chain.length - 1; i >= 0; i--) {
			const { json } = chain[i];
			if (json.ambientocclusion !== undefined) {
				ambientOcclusion = json.ambientocclusion;
			}
			if (typeof json.render_type === 'string') {
				renderType = json.render_type.replace(/^minecraft:/, '');
			}
			for (const [name, value] of Object.entries(json.textures ?? {})) {
				// 1.21.5+ allows {"sprite": "..."} objects in texture maps.
				textures[name] = typeof value === 'object' && value !== null
					? String((value as { sprite?: string; }).sprite ?? '')
					: value;
			}
			Object.assign(display, json.display);
			if (json.gui_light !== undefined) {
				guiLight = json.gui_light;
			}
			if (json.elements !== undefined) {
				elements = normalizeElements(json.elements);
				// Elements capture the light in effect where they are defined (same-file
				// gui_light applies first); later overrides don't relight them.
				elementsGuiLight = guiLight;
			}
		}

		// OBJ geometry declared anywhere in the chain (deepest wins).
		let obj: { model: string; flipV: boolean; objects?: string[]; conditional?: boolean; } | undefined;
		for (const entry of chain) {
			const marked = entry.json as ModelJson & { objModel?: { model: string; flipV: boolean; objects?: string[]; conditional?: boolean; }; };
			if (marked.objModel) {
				obj = marked.objModel;
				break;
			}
		}

		// Block offsets a split multiblock spans (deepest wins).
		let splitParts: Array<[number, number, number]> | undefined;
		for (const entry of chain) {
			const marked = entry.json as ModelJson & { splitParts?: Array<[number, number, number]>; };
			if (marked.splitParts) {
				splitParts = marked.splitParts;
				break;
			}
		}

		// Contained fluid from a fluid_container loader (deepest wins).
		let fluid: string | undefined;
		for (const entry of chain) {
			const marked = entry.json as ModelJson & { fluidContained?: string; };
			if (marked.fluidContained) {
				fluid = marked.fluidContained;
				break;
			}
		}

		// Models a loader composes alongside this one (deepest wins). Their
		// elements are appended with texture variables already resolved, so two
		// merged models cannot collide over a shared `#name`.
		for (const entry of chain) {
			const merges = (entry.json as ModelJson & { mergeModels?: string[]; }).mergeModels;
			if (!merges) {
				continue;
			}
			for (const reference of merges) {
				const merged = await this.load(reference).catch(() => null);
				if (!merged) {
					continue;
				}
				elements = [...elements, ...merged.elements.map(element => bindElementTextures(element, merged, textures))];
			}
			break;
		}

		// Model default is side (master, dcf19ec); builtin/generated sprites light front.
		// A legacy-era model may carry nothing but an `overrides` list, leaving the
		// chain with no layers or elements to draw even when it parents onto
		// item/generated. An inventory stack reads every predicate as 0, which is
		// the state upstream resolves the list against.
		if (obj === undefined && elements.length === 0 && Object.keys(textures).length === 0) {
			const overridden = chain.find(entry => entry.json.overrides?.length)?.json.overrides;
			const chosen = overridden
				&& (overridden.findLast(entry => Object.values(entry.predicate).every(value => value <= 0)) ?? overridden[0]);
			const target = chosen ? ResourceLocator.tryParse(chosen.model) : null;
			// Resolved directly rather than through load(): an override may name the
			// model it sits in (armourers_workshop:item/skin lists itself as its
			// unloaded state), and load() hands back the in-flight promise for a key
			// it is already resolving — so the model would await itself forever.
			// The depth cap covers the same cycle spread across several models.
			if (target && overrideDepth < MAX_OVERRIDE_REDIRECTS && target.toString() !== locator.toString()) {
				return this.resolve(target, overrideDepth + 1);
			}
		}

		const defaultLight = builtinParent === 'builtin/generated' ? 'front' : 'side';
		return {
			obj,
			fluid,
			splitParts,
			renderType: renderType ?? null,
			locator,
			builtinParent,
			ambientOcclusion: ambientOcclusion ?? true,
			guiLight: guiLight ?? defaultLight,
			elementsGuiLight: elementsGuiLight ?? defaultLight,
			display,
			textures,
			elements,
			chain: chain.map(entry => entry.locator.toString()),
		};
	}

	/** Load and flatten a model by locator string (e.g. `minecraft:item/stone`). */
	async load(locator: string | ResourceLocator): Promise<ResolvedModel> {
		const parsed = typeof locator === 'string' ? ResourceLocator.parse(locator) : locator;
		const key = parsed.toString();
		let pending = this.cache.get(key);
		if (!pending) {
			pending = this.resolve(parsed);
			this.cache.set(key, pending);
		}
		return pending;
	}
}

/**
 * Rewrite an element's face textures from the owning model's variables to
 * concrete locators, so the element survives being merged into another model.
 */
function bindElementTextures(
	element: ModelElementJson,
	model: ResolvedModel,
	owner: Record<string, string>,
): ModelElementJson {
	// The composing model's bindings win over the part's own defaults, the way a
	// child model overrides its parent's textures — Sophisticated Storage's
	// barrel parts all default to acacia and are rebound per tier.
	const rebound: ResolvedModel = { ...model, textures: { ...model.textures, ...owner } };
	const faces: ModelElementJson['faces'] = {};
	for (const [direction, face] of Object.entries(element.faces)) {
		if (!face) {
			continue;
		}
		const bound = resolveTexture(rebound, face.texture) ?? resolveTexture(model, face.texture);
		faces[direction as keyof ModelElementJson['faces']] = bound ? { ...face, texture: bound.toString() } : face;
	}
	return { ...element, faces };
}

/**
 * Resolve a texture variable (`#layer0`) through the merged texture map to a locator.
 * Returns null for unresolved variables — the caller decides whether that fails the
 * item or just the face.
 */
export function resolveTexture(model: ResolvedModel, reference: string): ResourceLocator | null {
	let value = reference;
	for (let depth = 0; depth < MAX_TEXTURE_REF_DEPTH; depth++) {
		// The game strips the `#` and resolves a face's texture as a variable
		// either way, so the sigil is decorative — vanilla's own
		// block/heavy_core writes `"texture": "all"` and draws fine. A bare name
		// matching no variable is still treated as a direct locator.
		const name = value.startsWith('#') ? value.slice(1) : value;
		const next = model.textures[name];
		if (next === undefined) {
			return value.startsWith('#') ? null : ResourceLocator.tryParse(value);
		}
		value = next;
	}
	return null;
}
