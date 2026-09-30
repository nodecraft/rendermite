/**
 * Block light emission for the exported pack: `light.json`.
 *
 * Nothing in a jar's assets says a torch glows. Emission is set in Java, per block and often per
 * blockstate — `Properties.lightLevel(state -> state.getValue(LIT) ? 7 : 0)` — so this reads the code,
 * with the interpreter in `light-bytecode.ts`, for vanilla and mods alike. A mod's registry class is
 * found the same way vanilla's is: it is the class whose string constants name the blocks.
 *
 * `VANILLA_LIGHT` is the check on that machinery, not its source. It is transcribed from `Blocks.java`
 * and the wiki, and the test suite holds the extraction to it version by version: a block the
 * interpreter reads differently from the table is a bug in one or the other, and either way a person
 * looks. Mods have no table — their answers come from the code alone, and a block whose registration
 * or light function the interpreter could not follow is recorded in `failures.json` rather than
 * shipped dark.
 */

import { blockBehaviour } from './block-behaviour.ts';
import { extractBlockLight } from './light-bytecode.ts';
import { parseClassFile } from '../entities/classfile.ts';
import { MappingsUnavailableError, remapDescriptor, resolveMappings } from '../entities/mappings.ts';
import { compareVersions } from '../versions/prepare.ts';

import type { BlockBehaviour } from './block-behaviour.ts';
import type { LightCodeSource, LightGetter, MemberReference } from './light-bytecode.ts';
import type { BlockPackLight } from './pack-format.ts';
import type { ClassFile } from '../entities/classfile.ts';
import type { ClassSource } from '../entities/jar-classes.ts';
import type { Mappings } from '../entities/mappings.ts';

export interface CollectBlockLightOptions {
	version: string;
	/** Where mappings cache; the jar cache directory. */
	cacheDir: string;
	classes: ClassSource;
	/** Every block the pack describes, fully qualified; each gets an answer or a failure. */
	blockIds: readonly string[];
	/** Blocks to describe in `notes` — what was registered and with which light — for chasing a failure. */
	trace?: readonly string[];
	onProgress?: (done: number, total: number) => void;
}

export interface BlockLightResult {
	/** Only the blocks that emit; absent is 0. */
	light: Record<string, BlockPackLight>;
	/**
	 * What each block does, from the same run: hardness, collision, map colour. Empty on a version with
	 * no mappings (1.13), whose builder calls have no names to read.
	 */
	behaviour: Record<string, BlockBehaviour>;
	failures: Array<{ id: string; reason: string; }>;
	/** Blocks whose behaviour was partly unreadable, kept apart from light's so each file owns its gaps. */
	behaviourFailures: Array<{ id: string; reason: string; }>;
	/** What the interpreter gave up on along the way, for a person reading a failure. */
	notes: string[];
}

const TO_INT_FUNCTION = 'Ljava/util/function/ToIntFunction;';
/** Registry classes to interpret, by how many of the pack's block names they mention. */
const MAX_ROOTS = 24;
/** Classes added for reading those classes' fields, and how many reads it takes to count. */
const MAX_REFERRERS = 2;
const MIN_REFERRER_REFS = 100;

/**
 * Blockstate files that describe no block. The item frames are entities whose model the game looks up
 * through a blockstate, so they have no registration to find and emit nothing.
 */
const NOT_BLOCKS = new Set(['minecraft:item_frame', 'minecraft:glow_item_frame']);

/** Strings a class's constant pool holds, for spotting the one that registers the blocks. */
function stringConstants(classFile: ClassFile): Set<string> {
	const strings = new Set<string>();
	for (const [index, constant] of classFile.constants.entries()) {
		if (constant?.tag === 'string') {
			strings.add(classFile.utf8(index));
		}
	}
	return strings;
}

/**
 * The `Properties` builder class, in whatever the jars call it.
 *
 * Named by shape rather than by name, since an obfuscated jar has none: it is the class with a fluent
 * method taking a `ToIntFunction` (the light function, 1.16+), and failing that the class most block
 * constructors take as their last argument (1.13–1.15, where the light method takes an `int`).
 */
function findPropsClasses(
	roots: readonly ClassFile[],
	remapClass: (name: string) => string,
	resolve: (internalName: string) => ClassFile | null,
): Set<string> {
	const found = new Set<string>();
	const lastParams = new Map<string, number>();
	for (const classFile of roots) {
		for (const [index, constant] of classFile.constants.entries()) {
			if (constant?.tag !== 'methodref' && constant?.tag !== 'interfaceMethodref') {
				continue;
			}
			const reference = classFile.reference(index);
			if (!reference) {
				continue;
			}
			// `Comparator.comparingInt` has the shape too; the builder is never a JDK class
			if (reference.descriptor === `(${TO_INT_FUNCTION})L${reference.owner};` && !reference.owner.startsWith('java/')) {
				found.add(reference.owner);
			}
			if (reference.name === '<init>') {
				const match = /L([^;]+);\)V$/.exec(reference.descriptor);
				if (match && !match[1].startsWith('java/')) {
					lastParams.set(match[1], (lastParams.get(match[1]) ?? 0) + 1);
				}
			}
		}
	}
	/*
	 * A `Comparator.comparingInt` or an enum's own int-function method has the shape too. The builder
	 * is a plain class with the fluent no-argument methods a builder has, so anything else is dropped.
	 */
	for (const name of found) {
		const classFile = resolve(name);
		const fluent = classFile?.methods.filter(method => method.descriptor === `()L${name};`).length ?? 0;
		if (!classFile || classFile.superClass === 'java/lang/Enum' || fluent < 3) {
			found.delete(name);
		}
	}
	// The game's own builder by name, for a mod jar whose registry classes never call `lightLevel`
	for (const known of ['net/minecraft/world/level/block/state/BlockBehaviour$Properties', 'net/minecraft/world/level/block/Block$Properties']) {
		const internal = remapClass(known);
		if (resolve(internal)) {
			found.add(internal);
			found.add(known);
		}
	}
	if (found.size === 0) {
		const commonest = [...lastParams].toSorted((left, right) => right[1] - left[1])[0];
		if (commonest && commonest[1] >= 3) {
			found.add(commonest[0]);
		}
	}
	// Both spellings of each: the jar's own, and the original a mod's constant pool uses
	const spelled = new Set(found);
	for (const name of found) {
		spelled.add(remapClass(name));
	}
	return spelled;
}

/**
 * Classes that lean on the named ones without naming any block themselves.
 *
 * From the 26 line `Blocks.<clinit>` holds no block name at all: the ids live in `BlockItemIds`, and
 * `Blocks` reads them as static fields. The class with the most field reads into the named classes is
 * that registry.
 */
function referrers(
	named: readonly ClassFile[],
	all: Iterable<string>,
	resolve: (internalName: string) => ClassFile | null,
): ClassFile[] {
	const targets = new Set(named.map(classFile => classFile.thisClass));
	const scored: Array<{ classFile: ClassFile; refs: number; }> = [];
	for (const internal of all) {
		if (targets.has(internal)) {
			continue;
		}
		const classFile = resolve(internal);
		if (!classFile) {
			continue;
		}
		let refs = 0;
		for (const [index, constant] of classFile.constants.entries()) {
			if (constant?.tag === 'fieldref' && targets.has(classFile.reference(index)?.owner ?? '')) {
				refs++;
			}
		}
		if (refs >= MIN_REFERRER_REFS) {
			scored.push({ classFile, refs });
		}
	}
	return scored
		.toSorted((left, right) => right.refs - left.refs || left.classFile.thisClass.localeCompare(right.classFile.thisClass))
		.slice(0, MAX_REFERRERS)
		.map(entry => entry.classFile);
}

/** The code of a method as `[opcode, operand bytes…]` groups, for matching a trivial body by shape. */
function trivialGetterField(code: Uint8Array): { index: number; } | null {
	// aload_0; getfield #n; ireturn
	return code.length === 5 && code[0] === 0x2A && code[1] === 0xB4 && code[4] === 0xAC
		? { index: (code[2] << 8) | code[3] }
		: null;
}

/**
 * The methods a block class overrides to state its own light.
 *
 * Before 1.16 that is how a lit furnace worked: `Properties.lightValue(13)` on the block, and
 * `getLightValue(state)` returning it or zero by `LIT`. An obfuscated jar names neither, so both are
 * found by shape: the properties method that takes one `int`, the field it sets, the field the block's
 * base constructor copies it into, and the base method that is nothing but a read of that field.
 *
 * From 1.16 the light is a lambda on the properties and vanilla overrides nothing, but a loader adds
 * `getLightEmission(state, level, pos)` for mods, which is matched by its name — a mod jar keeps them.
 */
function findLightGetters(
	roots: readonly ClassFile[],
	propsClasses: ReadonlySet<string>,
	resolve: (internalName: string) => ClassFile | null,
	notes: string[],
): LightGetter[] {
	const getters: LightGetter[] = [{
		name: 'getLightEmission',
		descriptor: '',
		root: null,
	}];
	const props = [...propsClasses].map(name => resolve(name)).find(classFile => classFile !== null);
	if (!props) {
		notes.push('light getters: no properties class resolves');
		return getters;
	}
	const hasLambdaForm = props.methods.some(method => method.descriptor === `(${TO_INT_FUNCTION})L${props.thisClass};`);
	if (hasLambdaForm) {
		return getters;
	}
	const setter = props.methods.find(method => method.descriptor === `(I)L${props.thisClass};` && method.code);
	// aload_0; iload_1; putfield #n; aload_0; areturn
	const setterCode = setter?.code;
	if (!setterCode || setterCode.length !== 7 || setterCode[0] !== 0x2A || setterCode[1] !== 0x1B || setterCode[2] !== 0xB5) {
		notes.push(`light getters: no int setter of the expected shape on ${props.thisClass} (${setter ? `${setter.name}: ${setterCode?.length ?? 0} bytes` : 'none'})`);
		return getters;
	}
	const propsField = props.reference((setterCode[3] << 8) | setterCode[4]);
	if (!propsField) {
		return getters;
	}
	// The base block class: the top of the chain of classes constructed with these properties
	const ctorDescriptor = `(L${props.thisClass};)V`;
	const bases = new Map<string, number>();
	for (const classFile of roots) {
		for (const [index, constant] of classFile.constants.entries()) {
			if (constant?.tag !== 'methodref') {
				continue;
			}
			const reference = classFile.reference(index);
			if (reference?.name !== '<init>' || reference.descriptor !== ctorDescriptor) {
				continue;
			}
			let at: ClassFile | null = resolve(reference.owner);
			let top: string | null = null;
			for (let hops = 0; at && hops < 12; hops++) {
				if (at.methods.some(method => method.name === '<init>' && method.descriptor === ctorDescriptor)) {
					top = at.thisClass;
				}
				at = at.superClass ? resolve(at.superClass) : null;
			}
			if (top) {
				bases.set(top, (bases.get(top) ?? 0) + 1);
			}
		}
	}
	const base = [...bases].toSorted((left, right) => right[1] - left[1])[0];
	const baseClass = base ? resolve(base[0]) : null;
	const baseCtor = baseClass?.methods.find(method => method.name === '<init>' && method.descriptor === ctorDescriptor)?.code;
	if (!baseClass || !baseCtor) {
		notes.push(`light getters: no base block class found (${bases.keys().toArray().join(', ') || 'no constructors'})`);
		return getters;
	}
	/*
	 * In the constructor: a read of the properties' light — `getfield`, or the synthetic static accessor
	 * javac emits for a nested class's private field, whose body is that `getfield` — then the `putfield`
	 * that stores it on the block.
	 */
	const readsPropsField = (reference: { owner: string; name: string; descriptor: string; } | null, viaCall: boolean): boolean => {
		if (!reference) {
			return false;
		}
		if (!viaCall) {
			return reference.owner === propsField.owner && reference.name === propsField.name;
		}
		const accessor = resolve(reference.owner)?.methods.find(method => method.name === reference.name && method.descriptor === reference.descriptor);
		// aload_0; getfield #n; xreturn
		const code = accessor?.code;
		if (!code || code.length !== 5 || code[0] !== 0x2A || code[1] !== 0xB4) {
			return false;
		}
		const field = resolve(reference.owner)?.reference((code[2] << 8) | code[3]);
		return field?.owner === propsField.owner && field.name === propsField.name;
	};
	let blockField: string | null = null;
	for (let at = 0; at + 6 < baseCtor.length; at++) {
		if (baseCtor[at] !== 0xB4 && baseCtor[at] !== 0xB8) {
			continue;
		}
		const read = baseClass.reference((baseCtor[at + 1] << 8) | baseCtor[at + 2]);
		if (readsPropsField(read, baseCtor[at] === 0xB8) && baseCtor[at + 3] === 0xB5) {
			const written = baseClass.reference((baseCtor[at + 4] << 8) | baseCtor[at + 5]);
			blockField = written ? `${written.owner}.${written.name}` : null;
			break;
		}
	}
	if (!blockField) {
		notes.push(`light getters: ${baseClass.thisClass}.<init> does not copy ${propsField.owner}.${propsField.name}`);
		return getters;
	}
	for (const method of baseClass.methods) {
		const shape = method.code ? trivialGetterField(method.code) : null;
		if (!shape || !/^\(L[^;]+;\)I$/.test(method.descriptor)) {
			continue;
		}
		const field = baseClass.reference(shape.index);
		if (field && `${field.owner}.${field.name}` === blockField) {
			getters.push({ name: method.name, descriptor: method.descriptor, root: baseClass.thisClass });
		}
	}
	return getters;
}

/** Reference renaming through the mappings: a mod's original names onto an obfuscated client's. */
function remapper(
	mappings: Mappings,
	superOf: (internalName: string) => string | null = () => null,
): Pick<LightCodeSource, 'remap' | 'remapClass' | 'nameOf'> {
	const remapClass = (internalName: string): string => {
		const mapped = mappings.obfuscatedOf.get(internalName.replaceAll('/', '.'));
		return mapped ? mapped.replaceAll('.', '/') : internalName;
	};
	const remap = (reference: MemberReference, field: boolean): MemberReference => {
		const dotted = reference.owner.replaceAll('/', '.');
		const owner = mappings.obfuscatedOf.get(dotted);
		if (!owner || owner === dotted) {
			return reference;
		}
		const member = field
			? mappings.fieldOf.get(`${dotted}.${reference.name}`)
			: mappings.methodOf.get(`${dotted}.${reference.name}${reference.descriptor}`);
		return {
			owner: owner.replaceAll('.', '/'),
			name: member ?? reference.name,
			descriptor: remapDescriptor(reference.descriptor, mappings.obfuscatedOf),
		};
	};
	/*
	 * Keyed by the class that declares the member, where a call names the class it was made through:
	 * `OAK_PLANKS.defaultMapColor()` is spelled on `Block` and declared on `BlockBehaviour`, so the
	 * lookup climbs. Fields are keyed without a descriptor, methods with the one the jar spells.
	 */
	const nameOf = (reference: MemberReference, field: boolean): string => {
		let owner: string | null = reference.owner;
		for (let hops = 0; owner && hops < 8; hops++) {
			const dotted = owner.replaceAll('/', '.');
			const found = mappings.nameOf?.get(field ? `${dotted}.${reference.name}` : `${dotted}.${reference.name}${reference.descriptor}`);
			if (found) {
				return found;
			}
			owner = superOf(owner);
		}
		return reference.name;
	};
	return { remap, remapClass, nameOf };
}

export async function collectBlockLight(options: CollectBlockLightOptions): Promise<BlockLightResult> {
	const { classes, blockIds } = options;
	const failures: Array<{ id: string; reason: string; }> = [];
	const notes: string[] = [];
	const names = await classes.list();

	let mappings: Mappings;
	try {
		({ mappings } = await resolveMappings(options.version, options.cacheDir, async () => names));
	} catch (err) {
		if (!(err instanceof MappingsUnavailableError)) {
			throw err;
		}
		/*
		 * 1.13-era: obfuscated, and no mappings to be had. The interpreter reads shape rather than names,
		 * so vanilla still works; what is lost is a mod's references *into* the client, which no 1.13 mod
		 * this exports has anyway.
		 */
		mappings = { obfuscatedOf: new Map(), originalOf: new Map(), fieldOf: new Map(), methodOf: new Map() };
		notes.push(err.message);
	}
	const { remap, remapClass } = remapper(mappings);
	// 26.x ships unobfuscated, so its calls carry their names with no mappings at all
	const isClearJar = names.some(name => name.replaceAll('.', '/') === 'net/minecraft/world/level/block/Blocks');

	/*
	 * Every class, read once and parsed on demand. Interpretation is synchronous and a call's target is
	 * only known when it is reached, so the whole jar has to be in hand — thirty-odd megabytes for a
	 * client, for the duration of one export.
	 */
	const bytes = new Map<string, Uint8Array>();
	for (const name of names) {
		const read = await classes.read(name);
		if (read) {
			bytes.set(name.replaceAll('.', '/'), read);
		}
	}
	const parsed = new Map<string, ClassFile | null>();
	const resolve = (name: string): ClassFile | null => {
		const internal = name.replaceAll('.', '/');
		if (!parsed.has(internal)) {
			const raw = bytes.get(internal);
			let classFile: ClassFile | null;
			try {
				classFile = raw ? parseClassFile(raw) : null;
			} catch {
				classFile = null;
			}
			parsed.set(internal, classFile);
		}
		return parsed.get(internal) ?? null;
	};

	const { nameOf } = remapper(mappings, name => resolve(name)?.superClass ?? null);

	// The registry classes: those whose constants name the blocks
	const wanted = new Set<string>();
	for (const id of blockIds) {
		wanted.add(id);
		wanted.add(id.includes(':') ? id.slice(id.indexOf(':') + 1) : id);
	}
	const scored: Array<{ classFile: ClassFile; hits: number; }> = [];
	let scanned = 0;
	for (const internal of bytes.keys()) {
		options.onProgress?.(++scanned, bytes.size);
		const classFile = resolve(internal);
		if (!classFile) {
			continue;
		}
		let hits = 0;
		for (const text of stringConstants(classFile)) {
			if (wanted.has(text)) {
				hits++;
			}
		}
		if (hits > 0) {
			scored.push({ classFile, hits });
		}
	}
	const named = scored
		.toSorted((left, right) => right.hits - left.hits || left.classFile.thisClass.localeCompare(right.classFile.thisClass))
		.slice(0, MAX_ROOTS)
		.map(entry => entry.classFile);
	const roots = [...named, ...referrers(named, bytes.keys(), resolve)];
	if (roots.length === 0) {
		// An asset-only jar: one line per namespace, not one per block, since the answer is the same for all
		for (const namespace of new Set(blockIds.map(id => (id.includes(':') ? id.slice(0, id.indexOf(':')) : 'minecraft')))) {
			failures.push({ id: namespace, reason: 'no class in the jars names its blocks; light unknown for all of them' });
		}
		return { light: {}, behaviour: {}, failures, behaviourFailures: [], notes };
	}

	const propsClasses = findPropsClasses(roots, remapClass, resolve);
	const source: LightCodeSource = {
		resolve,
		remap,
		remapClass,
		nameOf,
		propsClasses,
		lightGetters: findLightGetters(roots, propsClasses, resolve, notes),
		// The game's classes are the mapped ones on an obfuscated jar, and `net.minecraft` on a clear one;
		// with no mappings at all (1.13) there is nothing but the game to tell apart
		isVanillaClass: name => mappings.originalOf.size === 0 || mappings.originalOf.has(name.replaceAll('/', '.')) || name.startsWith('net/minecraft/') || name.startsWith('com/mojang/'),
	};
	notes.push(
		`registry classes: ${roots.map(root => root.thisClass).join(', ')}`,
		`properties classes: ${[...propsClasses].join(', ') || 'none found'}`,
		`light getters: ${source.lightGetters.map(getter => `${getter.root ?? '*'}.${getter.name}${getter.descriptor}`).join(', ') || 'none'}`,
	);
	const extraction = extractBlockLight(roots, source);
	notes.push(...extraction.notes);
	for (const id of options.trace ?? []) {
		notes.push(extraction.describe(id));
	}

	const light: Record<string, BlockPackLight> = {};
	for (const id of blockIds) {
		if (NOT_BLOCKS.has(id)) {
			continue;
		}
		const answer = extraction.lightOf(id);
		if ('failure' in answer) {
			failures.push({ id, reason: answer.failure });
		} else if (answer.light !== 0) {
			light[id] = answer.light;
		}
	}

	/*
	 * A mod's blocks the jar lists no blockstate for — nautec's prismarine crystal is drawn by a block
	 * entity renderer and has none — are still registered in its code, and still light the world. For a
	 * one-namespace mod export every registration the mod's own code made is asked as well; only the
	 * emitters are kept, since a name that is not a block cannot be told apart otherwise.
	 */
	const modNamespaces = new Set(blockIds.map(id => id.slice(0, id.indexOf(':'))).filter(namespace => namespace !== 'minecraft'));
	if (modNamespaces.size === 1) {
		const [namespace] = modNamespaces;
		const listed = new Set(blockIds);
		for (const [name, registration] of extraction.registrations) {
			if (name.includes(':') || registration.vanilla || listed.has(`${namespace}:${name}`)) {
				continue;
			}
			const answer = extraction.lightOf(`${namespace}:${name}`);
			if ('light' in answer && answer.light !== 0) {
				light[`${namespace}:${name}`] = answer.light;
				notes.push(`${namespace}:${name} emits but ships no blockstate; kept from its registration alone`);
			}
		}
	}

	const behaviour: Record<string, BlockBehaviour> = {};
	const behaviourFailures: Array<{ id: string; reason: string; }> = [];
	if (mappings.originalOf.size > 0 || isClearJar) {
		for (const id of blockIds) {
			const registration = NOT_BLOCKS.has(id) ? null : extraction.registrationOf(id);
			const read = registration ? blockBehaviour(registration, extraction) : null;
			if (read) {
				behaviour[id] = read.behaviour;
				for (const reason of read.failures) {
					behaviourFailures.push({ id, reason });
				}
			}
		}
	}
	return { light, behaviour, failures, behaviourFailures, notes };
}

/** `lit ? level : 0`, the shape a furnace, a redstone lamp or a campfire has. */
const lit = (level: number): BlockPackLight => {
	return { default: 0, cases: [{ when: { lit: 'true' }, level }] };
};

/**
 * Vanilla's emitters, transcribed from `Blocks.java` across 1.13 → 26.2 and checked against the wiki.
 *
 * By path, as a superset across versions: a block a version does not have never comes up in one of its
 * worlds, and none of these levels has changed since the block was added. Cases are in the folded form
 * the extractor emits — the commonest level as `default`, the rest as the fewest properties that
 * decide them — so the two can be compared directly.
 */
export const VANILLA_LIGHT: Record<string, BlockPackLight> = {
	beacon: 15,
	conduit: 15,
	copper_lantern: 15,
	exposed_copper_lantern: 15,
	weathered_copper_lantern: 15,
	oxidized_copper_lantern: 15,
	waxed_copper_lantern: 15,
	waxed_exposed_copper_lantern: 15,
	waxed_weathered_copper_lantern: 15,
	waxed_oxidized_copper_lantern: 15,
	end_gateway: 15,
	end_portal: 15,
	fire: 15,
	glowstone: 15,
	jack_o_lantern: 15,
	lantern: 15,
	lava: 15,
	lava_cauldron: 15,
	ochre_froglight: 15,
	pearlescent_froglight: 15,
	sea_lantern: 15,
	shroomlight: 15,
	verdant_froglight: 15,
	campfire: lit(15),
	redstone_lamp: lit(15),
	end_rod: 14,
	torch: 14,
	wall_torch: 14,
	copper_torch: 14,
	copper_wall_torch: 14,
	cave_vines: { default: 0, cases: [{ when: { berries: 'true' }, level: 14 }] },
	cave_vines_plant: { default: 0, cases: [{ when: { berries: 'true' }, level: 14 }] },
	blast_furnace: lit(13),
	furnace: lit(13),
	smoker: lit(13),
	nether_portal: 11,
	crying_obsidian: 10,
	soul_campfire: lit(10),
	soul_fire: 10,
	soul_lantern: 10,
	soul_torch: 10,
	soul_wall_torch: 10,
	deepslate_redstone_ore: lit(9),
	redstone_ore: lit(9),
	enchanting_table: 7,
	ender_chest: 7,
	// `MultifaceBlock.hasAnyFace`: a lichen with no face at all is a state that can exist and does not glow
	glow_lichen: {
		default: 7,
		cases: [{ when: { down: 'false', east: 'false', north: 'false', south: 'false', up: 'false', west: 'false' }, level: 0 }],
	},
	redstone_torch: lit(7),
	redstone_wall_torch: lit(7),
	sculk_catalyst: 6,
	amethyst_cluster: 5,
	large_amethyst_bud: 4,
	magma_block: 3,
	medium_amethyst_bud: 2,
	firefly_bush: 2,
	brewing_stand: 1,
	brown_mushroom: 1,
	calibrated_sculk_sensor: 1,
	dragon_egg: 1,
	end_portal_frame: 1,
	sculk_sensor: 1,
	small_amethyst_bud: 1,
	sea_pickle: {
		default: 0,
		cases: [
			{ when: { pickles: '1', waterlogged: 'true' }, level: 6 },
			{ when: { pickles: '2', waterlogged: 'true' }, level: 9 },
			{ when: { pickles: '3', waterlogged: 'true' }, level: 12 },
			{ when: { pickles: '4', waterlogged: 'true' }, level: 15 },
		],
	},
	respawn_anchor: {
		default: 0,
		cases: [
			{ when: { charges: '1' }, level: 3 },
			{ when: { charges: '2' }, level: 7 },
			{ when: { charges: '3' }, level: 11 },
			{ when: { charges: '4' }, level: 15 },
		],
	},
	light: {
		default: 0,
		cases: Array.from({ length: 15 }, (_, index) => {
			return { when: { level: String(index + 1) }, level: index + 1 };
		}),
	},
	copper_bulb: lit(15),
	waxed_copper_bulb: lit(15),
	exposed_copper_bulb: lit(12),
	waxed_exposed_copper_bulb: lit(12),
	weathered_copper_bulb: lit(8),
	waxed_weathered_copper_bulb: lit(8),
	oxidized_copper_bulb: lit(4),
	waxed_oxidized_copper_bulb: lit(4),
	trial_spawner: {
		default: 8,
		cases: [
			{ when: { trial_spawner_state: 'cooldown' }, level: 0 },
			{ when: { trial_spawner_state: 'inactive' }, level: 0 },
			{ when: { trial_spawner_state: 'waiting_for_players' }, level: 4 },
		],
	},
	// `VaultState`: inactive is HALF_LIT (6); active, unlocking and ejecting are all LIT (12)
	vault: { default: 12, cases: [{ when: { vault_state: 'inactive' }, level: 6 }] },
};

/**
 * Where a block's light changed between versions: the table holds the current value, and a version at
 * or below `until` gets the older one instead (`0` for a block that did not glow yet).
 */
const VANILLA_LIGHT_HISTORY: ReadonlyArray<{ path: string; until: string; light: BlockPackLight; }> = [
	// 1.18 gave the enchanting table its glow; on Java it emitted nothing through 1.17
	{ path: 'enchanting_table', until: '1.17.1', light: 0 },
];

/** The vanilla table as it stood at a version: `VANILLA_LIGHT` with the history applied. */
export function vanillaLightAt(version: string): Record<string, BlockPackLight> {
	const table: Record<string, BlockPackLight> = { ...VANILLA_LIGHT };
	for (const change of VANILLA_LIGHT_HISTORY) {
		if (compareVersions(version, change.until) <= 0) {
			if (change.light === 0) {
				delete table[change.path];
			} else {
				table[change.path] = change.light;
			}
		}
	}
	return table;
}

const CANDLE_COLOURS = [
	'white',
	'orange',
	'magenta',
	'light_blue',
	'yellow',
	'lime',
	'pink',
	'gray',
	'light_gray',
	'cyan',
	'purple',
	'blue',
	'brown',
	'green',
	'red',
	'black',
];
for (const name of ['candle', ...CANDLE_COLOURS.map(colour => `${colour}_candle`)]) {
	VANILLA_LIGHT[name] = {
		default: 0,
		cases: [1, 2, 3, 4].map((candles) => {
			return { when: { candles: String(candles), lit: 'true' }, level: candles * 3 };
		}),
	};
	// A cake with a lit candle on it glows like the one candle
	VANILLA_LIGHT[`${name}_cake`] = lit(3);
}
