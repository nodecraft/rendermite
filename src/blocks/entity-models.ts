/**
 * Entity geometry for the pack: link each entity to the class that builds it, read that class's
 * bytecode, and stitch the sheets those models are drawn with.
 *
 * The pieces all live in `src/entities/` — this is the part that knows what a *pack* wants. Which is
 * mostly two things the extractor does not care about: several entities share one model (every zombie
 * in the game is a `HumanoidModel`), so models are keyed by class and pointed at rather than copied;
 * and the `uv` values in a model address the entity's own sheet, so those sheets have to be in an
 * atlas the consumer can sample.
 *
 * Needs the *code*, not just the assets. An `--assets` folder has none, and a pack exported from one
 * carries no entity geometry — which is the honest answer rather than a silent gap.
 */

import { findGeoForEntity } from './entity-geo.ts';
import { EQUIPMENT_SLOTS } from './pack-format.ts';
import { parseClassFile } from '../entities/classfile.ts';
import { ancestryOf, extractInheritedModel } from '../entities/inherit.ts';
import { buildModelNameIndex, classReader, linkEntityModel } from '../entities/link.ts';
import { MappingsUnavailableError, resolveMappings } from '../entities/mappings.ts';
import { extractArmourMesh, extractModel } from '../entities/model-bytecode.ts';
import { loadModelCode } from '../entities/model-code.ts';
import { ResourceLocator } from '../resources/locator.ts';

import type {
	EntityPackModel,
	EntityPackPart,
	EquipmentPack,
	EquipmentSlot,
} from './pack-format.ts';
import type { ClassFile } from '../entities/classfile.ts';
import type { ClassSource } from '../entities/jar-classes.ts';
import type { Mappings } from '../entities/mappings.ts';
import type { ModelCode } from '../entities/model-code.ts';
import type { ExtractedModel, Part } from '../entities/model.ts';
import type { ResourceManager } from '../resources/manager.ts';

export interface EntityGeometryResult {
	/** Model id (the class it came from) → geometry. */
	models: Record<string, EntityPackModel>;
	/** Entity id → model id, for the entity table to point with. */
	modelOf: Map<string, string>;
	/** Entity sheets the models address, to be stitched into the pack's own atlas. */
	spriteIds: Set<string>;
	/** Worn armour, where the version's classes described any. */
	equipment: EquipmentPack | null;
	failures: Array<{ id: string; reason: string; }>;
}

function countCubes(part: Part): number {
	return part.cubes.length + part.children.reduce((sum, child) => sum + countCubes(child), 0);
}

/** Drops the internal shape into the pack's, omitting what is at its default. */
function toPackPart(part: Part): EntityPackPart {
	return {
		name: part.name,
		pivot: [...part.pivot],
		rotation: [...part.rotation],
		cubes: part.cubes.map((cube) => {
			return {
				origin: [...cube.origin] as [number, number, number],
				size: [...cube.size] as [number, number, number],
				uv: [...cube.uv] as [number, number],
				...(cube.inflate !== 0 && { inflate: cube.inflate }),
				...(cube.mirror && { mirror: true as const }),
				...(cube.faces && { faces: cube.faces }),
			};
		}),
		children: part.children.map(child => toPackPart(child)),
	};
}

export interface CollectEntityGeometryOptions {
	version: string;
	/** Where mappings cache; the same directory the jars do. */
	cacheDir: string;
	classes: ClassSource;
	/** Entity ids to look for, as the registry named them. */
	entityIds: readonly string[];
	/** The sheet each entity resolved to, from the entity registry, keyed by entity id. */
	textureOf: ReadonlyMap<string, string>;
	/**
	 * The assets, for the mods whose geometry is not in code at all.
	 *
	 * A GeckoLib mob ships Blockbench's bedrock format and registers it by resource location, so there
	 * is nothing for the interpreter to read; `entity-geo.ts` finds and converts it instead.
	 */
	resources?: ResourceManager;
	onProgress?: (done: number, total: number) => void;
}

/**
 * Recovers geometry for as many of `entityIds` as the code describes.
 *
 * Mappings are resolved once: downloaded for an obfuscated jar, and the identity for one that is not
 * (from the 26 line the client ships in the clear, and a mod jar never was obfuscated). A version that
 * is obfuscated *and* unmapped — 1.13.x — yields nothing, with the reason recorded once rather than
 * per entity.
 */
export async function collectEntityGeometry(
	options: CollectEntityGeometryOptions,
): Promise<EntityGeometryResult> {
	const { classes, entityIds } = options;
	const models: Record<string, EntityPackModel> = {};
	const modelOf = new Map<string, string>();
	const spriteIds = new Set<string>();
	const failures: Array<{ id: string; reason: string; }> = [];

	const names = await classes.list();
	let mappings;
	try {
		({ mappings } = await resolveMappings(options.version, options.cacheDir, async () => names));
	} catch (err) {
		failures.push({
			id: options.version,
			reason: err instanceof MappingsUnavailableError
				? `no entity geometry: ${err.message}`
				: `no entity geometry: mappings could not be loaded (${(err as Error).message})`,
		});
		return { models, modelOf, spriteIds, equipment: null, failures };
	}

	/*
	 * The model code of the whole jar, because a model is rarely self-contained: it inherits parts from
	 * its superclass and borrows others from a sibling, and the interpreter needs both to follow the
	 * calls that build them.
	 */
	const code = await loadModelCode(
		names,
		async internal => await classes.read(internal),
		internal => mappings.originalOf.get(internal) ?? internal,
	);
	const extracted = new Map<string, ExtractedModel | null>();
	const geometryOf = async (internal: string): Promise<ExtractedModel | null> => {
		if (!extracted.has(internal)) {
			extracted.set(internal, await extractInheritedModel(internal, async name => await classes.read(name), code));
		}
		return extracted.get(internal) ?? null;
	};
	const context = {
		mappings,
		read: classReader(async internal => await classes.read(internal)),
		hasGeometry: async (internal: string): Promise<boolean> => {
			const model = await geometryOf(internal);
			return model !== null && model.parts.reduce((sum, part) => sum + countCubes(part), 0) > 0;
		},
		// Only a mod needs the fuzzy route; vanilla's named routes are exact
		nameIndex: buildModelNameIndex(names),
	};

	/*
	 * The bedrock fallback, for an entity whose model is not in the code. Tried only where the linker
	 * found no class, so a mod that writes its models in Java is never second-guessed by a name match.
	 */
	const geoFor = async (entityId: string): Promise<{ id: string; model: ExtractedModel; } | null> => {
		if (!options.resources) {
			return null;
		}
		const [namespace, name] = entityId.includes(':') ? entityId.split(':') : ['minecraft', entityId];
		return await findGeoForEntity(options.resources, namespace, name);
	};

	let done = 0;
	for (const entityId of [...entityIds].toSorted((left, right) => left.localeCompare(right))) {
		options.onProgress?.(++done, entityIds.length);
		const link = await linkEntityModel(entityId, context);
		/*
		 * A mod's own `.geo.json` beats a *guess* at a vanilla class, and loses to everything else. The
		 * `vanilla-name` route drops tokens off an id until something matches — right for `summon_horse`,
		 * but if the mod ships geometry under its own name then that is what the game draws.
		 */
		const guessed = link?.route === 'vanilla-name';
		const found = link && !guessed
			? { id: link.className, model: await geometryOf(link.obfuscated) }
			: await geoFor(entityId) ?? (link ? { id: link.className, model: await geometryOf(link.obfuscated) } : null);
		if (!found?.model) {
			continue;
		}
		const { id: modelId, model } = found;
		// Keyed by where it came from, so the twenty entities that share `HumanoidModel` share one entry
		if (!models[modelId]) {
			models[modelId] = {
				textureSize: [...model.textureSize] as [number, number],
				parts: model.parts.map(part => toPackPart(part)),
				...(model.notes.length > 0 && { notes: [...model.notes] }),
			};
		}
		modelOf.set(entityId, modelId);
		const texture = options.textureOf.get(entityId);
		if (texture) {
			spriteIds.add(texture);
		} else {
			/*
			 * Geometry with no sheet draws in the missing texture. Worth saying: the shape is right and
			 * only the skin is absent, which is a different problem from having no model at all.
			 */
			failures.push({ id: entityId, reason: `geometry recovered from ${modelId} but no entity texture resolved` });
		}
	}

	const equipment = await collectEquipment(
		names,
		mappings,
		async internal => await classes.read(internal),
		code,
		options.resources,
		models,
		spriteIds,
	);
	return { models, modelOf, spriteIds, equipment, failures };
}

/**
 * How much each armour layer grows the wearer's boxes by, in pixels.
 *
 * Not recovered from the code: the game passes these into the mesh builder from its renderers, so
 * following them means interpreting a renderer, which the extractor deliberately refuses to do. They
 * have been 1.0 and 0.5 since armour got its second layer, and getting them wrong only makes the two
 * layers fight rather than losing the shape.
 */
const ARMOUR_INFLATE = { outer: 1, inner: 0.5 } as const;

/** Which parts a slot lights up, and which layer it is drawn on. */
const ARMOUR_SLOTS: Record<EquipmentSlot, { parts: string[]; layer: 'inner' | 'outer'; }> = {
	head: { parts: ['head', 'hat'], layer: 'outer' },
	chest: { parts: ['body', 'right_arm', 'left_arm'], layer: 'outer' },
	// Leggings are the inner layer, drawn tighter so the chestplate over them has somewhere to go
	legs: { parts: ['body', 'right_leg', 'left_leg'], layer: 'inner' },
	feet: { parts: ['right_leg', 'left_leg'], layer: 'outer' },
};

/**
 * Where each layer's sheets live, across the two layouts the game has used.
 *
 * 1.21.2 moved armour under `entity/equipment/` and dropped the `_layer_N` suffix for a folder per
 * layer. Both are matched rather than switched on a version, so a resource pack or a mod following
 * either convention is found the same way.
 */
const ARMOUR_SHEETS: ReadonlyArray<{ layer: 'inner' | 'outer'; prefix: string; suffix: string; }> = [
	{ layer: 'outer', prefix: 'entity/equipment/humanoid/', suffix: '' },
	{ layer: 'inner', prefix: 'entity/equipment/humanoid_leggings/', suffix: '' },
	{ layer: 'outer', prefix: 'models/armor/', suffix: '_layer_1' },
	{ layer: 'inner', prefix: 'models/armor/', suffix: '_layer_2' },
];

/** The item name a material takes, where it is not simply the material's own. */
const ARMOUR_ITEM_PREFIX: Record<string, string> = { gold: 'golden', turtle_scute: 'turtle' };

/** Suffix per slot, as every vanilla armour item is named. */
const ARMOUR_ITEM_PIECE: Record<EquipmentSlot, string> = {
	head: 'helmet',
	chest: 'chestplate',
	legs: 'leggings',
	feet: 'boots',
};

interface ArmourTrimAtlasSource {
	type?: string;
	textures?: string[];
	permutations?: Record<string, string>;
	separator?: string;
}

/** The layer and world pattern id named by one of the paths in the armour-trim atlas. */
function trimSheet(locator: ResourceLocator): { layer: 'inner' | 'outer'; pattern: string; } | null {
	const name = locator.path.split('/').at(-1)?.replace(/\.png$/, '');
	if (!name) {
		return null;
	}
	if (locator.path.includes('/humanoid_leggings/')) {
		return { layer: 'inner', pattern: new ResourceLocator(locator.namespace, name).toString() };
	}
	if (locator.path.includes('/humanoid/')) {
		return { layer: 'outer', pattern: new ResourceLocator(locator.namespace, name).toString() };
	}
	// Before 1.21.2 both layers shared this folder and leggings carried the distinction as a suffix.
	if (locator.path.includes('trims/models/armor/')) {
		const leggings = name.endsWith('_leggings');
		const pattern = leggings ? name.slice(0, -'_leggings'.length) : name;
		return {
			layer: leggings ? 'inner' : 'outer',
			pattern: new ResourceLocator(locator.namespace, pattern).toString(),
		};
	}
	return null;
}

/** The registry id represented by a palette or pattern texture. */
function trimId(locator: ResourceLocator): string | null {
	const name = locator.path.split('/').at(-1)?.replace(/\.png$/, '');
	return name ? new ResourceLocator(locator.namespace, name).toString() : null;
}

/**
 * Reads the authored armour-trim atlas and names every generated worn sheet.
 *
 * The texture loader already resolves `paletted_permutations`; this only records the generated
 * sprite ids so the normal entity-atlas stitcher asks it for those pixels. Copies are visited from
 * lowest to highest precedence, matching atlas source resolution when packs extend the vanilla file.
 */
export async function collectArmourTrims(
	resources: ResourceManager,
	spriteIds: Set<string>,
): Promise<EquipmentPack['trims']> {
	const patterns: EquipmentPack['trims']['patterns'] = {};
	const darker: EquipmentPack['trims']['darker'] = {};
	for (const namespace of await resources.listNamespaces()) {
		const atlas = new ResourceLocator(namespace, 'armor_trims');
		const copies = await resources.getAllResources('atlas', atlas);
		for (const raw of copies.toReversed()) {
			let sources: ArmourTrimAtlasSource[];
			try {
				const parsed = JSON.parse(raw.toString('utf8')) as { sources?: ArmourTrimAtlasSource[]; };
				sources = parsed.sources ?? [];
			} catch {
				continue;
			}
			for (const source of sources) {
				if (String(source.type ?? '').replace(/^minecraft:/, '') !== 'paletted_permutations'
					|| !Array.isArray(source.textures) || !source.permutations) {
					continue;
				}
				const separator = source.separator ?? '_';
				for (const texture of source.textures) {
					const base = ResourceLocator.tryParse(texture.replace(/\.png$/, ''));
					if (!base) {
						continue;
					}
					const sheet = trimSheet(base);
					if (!sheet) {
						continue;
					}
					const { layer, pattern } = sheet;
					for (const [permutation, paletteName] of Object.entries(source.permutations)) {
						const palette = ResourceLocator.tryParse(paletteName.replace(/\.png$/, ''));
						const material = palette && trimId(palette);
						if (!material) {
							continue;
						}
						const sprite = new ResourceLocator(base.namespace, `${base.path}${separator}${permutation}`).toString();
						patterns[pattern] ??= {};
						patterns[pattern][material] = { ...patterns[pattern][material], [layer]: sprite };
						spriteIds.add(sprite);
						if (material.endsWith('_darker')) {
							const plain = material.slice(0, -'_darker'.length);
							darker[plain] = material;
						}
					}
				}
			}
		}
	}
	return { patterns, darker };
}

/**
 * The class holding the humanoid armour shape, across the three places the game has kept it.
 *
 * A dedicated `HumanoidArmorModel` is armour throughout, so the whole class is read. From the 26 line
 * it folded into `HumanoidModel` as a set of `create*ArmorMesh` factories beside the humanoid's own,
 * which is what `extractArmourMesh` picks out. Failing both, the humanoid itself is the right shape —
 * armour has never been anything but the wearer, grown.
 */
async function armourGeometry(
	names: readonly string[],
	mappings: Mappings,
	read: (internal: string) => Promise<Uint8Array | null>,
	code: ModelCode,
): Promise<{ className: string; model: ExtractedModel; } | null> {
	const find = (simple: string): string | undefined => names
		.find(name => (mappings.originalOf.get(name) ?? name).endsWith(`/${simple}`)
			|| (mappings.originalOf.get(name) ?? name).endsWith(`.${simple}`));
	const routes: Array<{ simple: string; armourOnly: boolean; }> = [
		{ simple: 'HumanoidArmorModel', armourOnly: false },
		{ simple: 'HumanoidModel', armourOnly: true },
		{ simple: 'HumanoidModel', armourOnly: false },
		{ simple: 'BipedModel', armourOnly: false },
	];
	for (const route of routes) {
		const internal = find(route.simple);
		const bytes = internal ? await read(internal) : null;
		if (!internal || !bytes) {
			continue;
		}
		const { ancestors } = await ancestryOf(internal, read);
		const resolve = (name: string): ClassFile | null => ancestors.get(name) ?? code.resolve(name);
		const model = route.armourOnly
			? extractArmourMesh(bytes, { resolve, isModelCode: true })
			: extractModel(bytes, { resolve, isModelCode: true });
		if (model.parts.reduce((sum, part) => sum + countCubes(part), 0) > 0) {
			return { className: mappings.originalOf.get(internal) ?? internal, model };
		}
	}
	return null;
}

/**
 * Worn armour for the pack: one humanoid mesh, the sheets each material is drawn with, and which
 * item is which.
 *
 * Materials are discovered from the sheets the version actually ships rather than listed, so a
 * version that adds one — copper, in the 26 line — needs no edit here. The item ids are the one part
 * the assets cannot answer, since nothing in them maps `iron_helmet` to `iron`: they follow the
 * game's own naming, and each is confirmed against a real item model before being claimed.
 */
/**
 * Where the game keeps the colour an undyed leather piece takes, newest first: 1.20.5 moved it from
 * the item class to the dyed-colour component. A `static final int`, so it is read off the field
 * itself, since javac copies the value into every place that uses it.
 */
const LEATHER_COLOUR_FIELDS: ReadonlyArray<readonly [string, string]> = [
	['net.minecraft.world.item.component.DyedItemColor', 'LEATHER_COLOR'],
	['net.minecraft.world.item.DyeableLeatherItem', 'DEFAULT_LEATHER_COLOR'],
];

async function undyedLeather(mappings: Mappings, read: (internal: string) => Promise<Uint8Array | null>): Promise<string | null> {
	for (const [owner, field] of LEATHER_COLOUR_FIELDS) {
		const bytes = await read((mappings.obfuscatedOf.get(owner) ?? owner).replaceAll('.', '/'));
		if (!bytes) {
			continue;
		}
		const name = mappings.fieldOf.get(`${owner}.${field}`) ?? field;
		const value = parseClassFile(bytes).fields.find(candidate => candidate.name === name)?.constant;
		if (typeof value === 'number') {
			return `#${(value & 0xFF_FF_FF).toString(16).padStart(6, '0')}`;
		}
	}
	return null;
}

export async function collectEquipment(
	names: readonly string[],
	mappings: Mappings,
	read: (internal: string) => Promise<Uint8Array | null>,
	code: ModelCode,
	resources: ResourceManager | undefined,
	models: Record<string, EntityPackModel>,
	spriteIds: Set<string>,
): Promise<EquipmentPack | null> {
	if (!resources) {
		return null;
	}
	const found = await armourGeometry(names, mappings, read, code);
	if (!found) {
		return null;
	}
	const materials: EquipmentPack['materials'] = {};
	const dyeable: string[] = [];
	const textures = await resources.listResources('texture', 'minecraft');
	for (const { layer, prefix, suffix } of ARMOUR_SHEETS) {
		for (const locator of textures) {
			if (!locator.path.startsWith(prefix)) {
				continue;
			}
			const name = locator.path.slice(prefix.length);
			/*
			 * A dye overlay is a second sheet for the same material rather than a material of its own:
			 * leather's sheet is greyscale and the overlay carries the parts that stay their own colour.
			 */
			const overlay = name.endsWith('_overlay');
			const bare = overlay ? name.slice(0, -'_overlay'.length) : name;
			if (!bare.endsWith(suffix)) {
				continue;
			}
			const material = bare.slice(0, bare.length - suffix.length);
			// `models/armor/` also holds the wolf's armour, which no humanoid wears
			if (material.length === 0 || material.includes('/')) {
				continue;
			}
			const id = `minecraft:${material}`;
			if (overlay) {
				if (!dyeable.includes(id)) {
					dyeable.push(id);
				}
				continue;
			}
			materials[id] = { ...materials[id], [layer]: locator.toString() };
			spriteIds.add(locator.toString());
		}
	}
	if (Object.keys(materials).length === 0) {
		return null;
	}

	const items: EquipmentPack['items'] = {};
	for (const material of Object.keys(materials)) {
		const bare = material.slice('minecraft:'.length);
		const prefix = ARMOUR_ITEM_PREFIX[bare] ?? bare;
		for (const slot of EQUIPMENT_SLOTS) {
			const id = `minecraft:${prefix}_${ARMOUR_ITEM_PIECE[slot]}`;
			// Turtle scute is a helmet and nothing else, and only the assets know that
			if (await resources.hasResource('model', new ResourceLocator('minecraft', `item/${prefix}_${ARMOUR_ITEM_PIECE[slot]}`))) {
				items[id] = { material, slot };
			}
		}
	}
	const trims = await collectArmourTrims(resources, spriteIds);
	const leather = dyeable.includes('minecraft:leather') ? await undyedLeather(mappings, read) : null;

	const modelKey = `${found.className}#armor`;
	models[modelKey] = {
		textureSize: [...found.model.textureSize] as [number, number],
		parts: found.model.parts.map(part => toPackPart(part)),
		...(found.model.notes.length > 0 && { notes: [...found.model.notes] }),
	};
	return {
		model: modelKey,
		inflate: { ...ARMOUR_INFLATE },
		slots: Object.fromEntries(
			EQUIPMENT_SLOTS.map(slot => [slot, [...ARMOUR_SLOTS[slot].parts]]),
		) as EquipmentPack['slots'],
		layerOf: Object.fromEntries(
			EQUIPMENT_SLOTS.map(slot => [slot, ARMOUR_SLOTS[slot].layer]),
		) as EquipmentPack['layerOf'],
		materials,
		items,
		dyeable,
		...(leather && { undyed: { 'minecraft:leather': leather } }),
		trims,
	};
}
