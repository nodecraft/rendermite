import { ResourceLocator } from '../resources/locator.ts';

import type {
	DisplayPosition,
	DisplayTransformJson,
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
	/** Forge/NeoForge OBJ loader geometry reference, when the chain declares one. */
	obj?: { model: string; flipV: boolean; };
	/** Fluid id from a fluid_container loader, for painting bucket contents. */
	fluid?: string;
}

export class ModelResolutionError extends Error {}

const MAX_PARENT_DEPTH = 64;
const MAX_TEXTURE_REF_DEPTH = 16;

/** Forge's generated-item aliases are injected by the loader, not shipped as resources. */
const MODEL_PARENT_ALIASES: Readonly<Record<string, string>> = {
	'forge:item/default': 'minecraft:item/generated',
	'forge:item/default-tool': 'minecraft:item/handheld',
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
	if (/obj$/i.test(loader)) {
		// OBJ geometry is handled by the renderer; normalize the reference here.
		const extended = json as ModelJson & { model?: string; flip_v?: boolean; flip_V?: boolean; };
		if (typeof extended.model === 'string') {
			const marked = withoutLoader(json) as ModelJson & { objModel?: { model: string; flipV: boolean; }; };
			marked.objModel = {
				model: extended.model,
				flipV: extended.flip_v ?? extended.flip_V ?? false,
			};
			delete (marked as { model?: string; }).model;
			return marked;
		}
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
	return withoutLoader(json);
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

export class ModelLoader {
	private readonly resources: ResourceManager;
	private readonly cache = new Map<string, Promise<ResolvedModel>>();
	private readonly jsonCache = new Map<string, Promise<ModelJson>>();

	constructor(resources: ResourceManager) {
		this.resources = resources;
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

	private async resolve(locator: ResourceLocator): Promise<ResolvedModel> {
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
			const json = await this.readModelJson(current);
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
		for (let i = chain.length - 1; i >= 0; i--) {
			const { json } = chain[i];
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
				elements = json.elements;
				// Elements capture the light in effect where they are defined (same-file
				// gui_light applies first); later overrides don't relight them.
				elementsGuiLight = guiLight;
			}
		}

		// OBJ geometry declared anywhere in the chain (deepest wins).
		let obj: { model: string; flipV: boolean; } | undefined;
		for (const entry of chain) {
			const marked = entry.json as ModelJson & { objModel?: { model: string; flipV: boolean; }; };
			if (marked.objModel) {
				obj = marked.objModel;
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

		// Model default is side (master, dcf19ec); builtin/generated sprites light front.
		const defaultLight = builtinParent === 'builtin/generated' ? 'front' : 'side';
		return {
			obj,
			fluid,
			locator,
			builtinParent,
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
 * Resolve a texture variable (`#layer0`) through the merged texture map to a locator.
 * Returns null for unresolved variables — the caller decides whether that fails the
 * item or just the face.
 */
export function resolveTexture(model: ResolvedModel, reference: string): ResourceLocator | null {
	let value = reference;
	for (let depth = 0; depth < MAX_TEXTURE_REF_DEPTH; depth++) {
		if (!value.startsWith('#')) {
			return ResourceLocator.tryParse(value);
		}
		const next = model.textures[value.slice(1)];
		if (next === undefined) {
			return null;
		}
		value = next;
	}
	return null;
}
