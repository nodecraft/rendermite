/**
 * Block light emission, read out of the code that registers blocks.
 *
 * No jar states how bright a torch is. Emission is a property set in Java — `Properties.lightLevel(state
 * -> 14)` in the registry class since 1.16, `lightValue(14)` before it — so the only automatic source
 * is the bytecode, exactly as for entity geometry (see docs/entity-geometry.md). The interpreter here
 * is its own rather than the geometry one because the questions differ: geometry follows a builder
 * vocabulary and abstracts everything else, where this follows *values* — a string naming a block, a
 * `Properties` object carrying its light, and a lambda from a state to a level — through whatever
 * code carries them, and abstracts the rest.
 *
 * Three ideas do the work:
 *
 * - **Taint.** Every object the interpreter cannot see into remembers the strings that went into it.
 *   `ResourceLocation.withDefaultNamespace("torch")`, a 26.x `BlockItemId.create("torch")` and a mod's
 *   `new ResourceLocation(MODID, "glow")` all become a value that knows it is about `torch` or `glow`.
 * - **Registration by shape.** A call whose arguments carry a name *and* a block or its `Properties`
 *   is a registration, whatever it is called and whichever class it is on. That covers vanilla's
 *   `register(String, Block)`, `register(String, Function, Properties)`, `Registry.register(Registry,
 *   ResourceLocation, T)`, and a mod's `DeferredRegister.register(String, Supplier)`, where the
 *   supplier is run to find the block.
 * - **Concrete evaluation.** A light *function* is run once per combination of the blockstate
 *   properties it reads, with real values, so `lit ? 3 * candles : 0` comes out as the eight cases it
 *   is rather than as a guess.
 *
 * Whatever this cannot follow is recorded, never guessed: a block whose registration was not found, or
 * whose light function reads something the interpreter does not model, is a failure entry, not a
 * dark block.
 */

import { statedMapColor } from './block-behaviour.ts';
import { parseDescriptor } from '../entities/model-bytecode.ts';

import type { BlockPackLight } from './pack-format.ts';
import type { ClassFile } from '../entities/classfile.ts';

/** A member reference as the constant pool spells it. */
export interface MemberReference {
	owner: string;
	name: string;
	descriptor: string;
}

/** What the caller supplies: how to find code, and how to rename a reference before looking. */
export interface LightCodeSource {
	/** The parsed class, or null for anything outside the jars (the JDK, a loader). */
	resolve: (internalName: string) => ClassFile | null;
	/**
	 * A reference as the jar spells it. A mod names the game's classes and members by their original
	 * names; against an obfuscated client those have to be renamed before they can be found.
	 */
	remap: (reference: MemberReference, field: boolean) => MemberReference;
	remapClass: (internalName: string) => string;
	/**
	 * A member's original name, for reading the game's own obfuscated calls: `eea$d.a(FF)` is `strength`.
	 * Absent, or answering the name it was given, where the jar already speaks original names.
	 */
	nameOf?: (reference: MemberReference, field: boolean) => string;
	/** Classes that are a block `Properties` builder, in every spelling the jars use. */
	propsClasses: ReadonlySet<string>;
	/**
	 * Whether a class is the game's rather than a mod's. A mod export runs the game's own `Blocks` too,
	 * for the properties mods copy, and its registrations must not answer for a mod block that happens
	 * to share a name — `immersiveengineering:lantern` is not `minecraft:lantern`.
	 */
	isVanillaClass: (internalName: string) => boolean;
	/**
	 * Methods a block class may override to answer its own light: the game's `getLightValue(state)`
	 * before 1.16, when a lit furnace was an override rather than a lambda, and a loader's
	 * `getLightEmission(state, level, pos)`. `root` is the class whose implementation is the plain
	 * property read, so a call resolving there — `super.getLightValue(state)` — is answered from the
	 * block's `Properties`.
	 */
	lightGetters: ReadonlyArray<LightGetter>;
}

export interface LightGetter {
	name: string;
	/** Empty to match by name alone: a loader method whose parameter types the jar does not spell. */
	descriptor: string;
	root: string | null;
}

/** Whether a call is to one of the block's light methods. */
function matchesGetter(getter: LightGetter, name: string, descriptor: string): boolean {
	if (getter.name !== name) {
		return false;
	}
	if (getter.descriptor !== '') {
		return getter.descriptor === descriptor;
	}
	const shape = parseDescriptor(descriptor);
	return shape.args.length === 3 && shape.returns === 'I';
}

/** The light method a block class declares or inherits, resolved to a real descriptor. */
function findGetter(
	source: LightCodeSource,
	owner: string,
	getter: LightGetter,
): { classFile: ClassFile; descriptor: string; } | null {
	if (getter.descriptor === '') {
		const found = findMethodNamed(source, owner, getter.name, 3, 'I');
		return found ? { classFile: found.classFile, descriptor: found.descriptor } : null;
	}
	const found = findMethod(source, owner, getter.name, getter.descriptor);
	return found ? { classFile: found.classFile, descriptor: getter.descriptor } : null;
}

/** How a block's light is stated, before it is evaluated. */
export type LightSpec =
	| { kind: 'constant'; level: number; }
	/** A `ToIntFunction<BlockState>`, to be run per state. */
	| { kind: 'function'; fn: LambdaValue; }
	/** A block class's own light method: a 1.13–1.15 `getLightValue` override, or a loader's `getLightEmission`. */
	| { kind: 'method'; owner: string; getter: LightGetter; receiver: Handle | null; }
	/** A light function the interpreter could not identify — one built from a value it never saw. */
	| { kind: 'opaque'; reason: string; };

export interface PropsCall {
	name: string;
	descriptor: string;
	args: Value[];
}

export interface Handle {
	id: number;
	/** Internal class name, from `new` or the declared return type of the opaque call that made it. */
	type: string | null;
	/** Strings that flowed into this object: the name a registration key or a property was made from. */
	strings: string[];
	numbers: number[];
	/** Class literals that flowed in: the value class of an enum property. */
	classes: string[];
	fields: Map<string, Value>;
	isProps: boolean;
	light: LightSpec | null;
	/** For a `Properties`: every builder call made on it, by its mapped name, for `block-behaviour.ts` to read. */
	calls?: PropsCall[];
	/** For a `Properties` made by copying a block's: the properties it copied, whose calls come first. */
	copyOf?: Handle | null;
	/** For a block: the `Properties` it was constructed with. */
	props: Handle | null;
	ctorArgs: Value[] | null;
	/** `StringBuilder` parts, for the pre-Java 9 way of building a name. */
	builder?: Array<string | number>;
	origin?: string;
	/** Entries of a map the code filled, for a lookup table of properties by direction. */
	map?: Array<{ key: Value; value: Value; }>;
	/** Elements of a list or set the code filled, for a table of names a mod registers in a loop. */
	items?: Value[];
	/** An iterator over a list: what it walks and where it is. */
	iterator?: { items: Value[]; at: number; };
}

export interface LambdaValue {
	kind: 'lambda';
	owner: string;
	name: string;
	descriptor: string;
	captured: Value[];
}

/** A `BlockState` during evaluation of a light function: a bag of property values being read. */
export interface StateProbe {
	values: Map<string, string>;
	domains: Map<string, PropertyDomain>;
	reads: Set<string>;
	failure: string | null;
}

export interface PropertyDomain {
	name: string;
	values: string[];
	/** The enum constant per serialized value, for a property whose values are an enum. */
	constants?: Map<string, Handle>;
}

export type Value =
	LambdaValue | { kind: 'number'; value: number; wide?: boolean; } | { kind: 'string'; value: string; } | { kind: 'object'; handle: Handle; } | { kind: 'array'; items: Value[]; } | { kind: 'class'; name: string; } | { kind: 'null'; } | { kind: 'state'; probe: StateProbe; } | { kind: 'unknown'; };

const UNKNOWN: Value = { kind: 'unknown' };

/** One registration this found: which `Properties` a name was registered with, and the block if seen. */
export interface Registration {
	props: Handle | null;
	block: Handle | null;
	/** The block's class, when a factory method reference named it. */
	blockType: string | null;
	/** The call that registered it, for a person chasing a wrong answer. */
	site: string;
	/** Made by the game's own code, which a mod's block of the same bare name must not inherit. */
	vanilla: boolean;
}

const TO_INT_FUNCTION = 'Ljava/util/function/ToIntFunction;';
/** JDK collections a mod fills with the names it registers, modelled as their elements. */
const LIST_CLASSES = /^java\/util\/(?:ArrayList|LinkedList|HashSet|LinkedHashSet|TreeSet|ArrayDeque|Vector|Stack)$/;

/** Instructions one root method may spend, every frame it inlines included. */
const STEP_BUDGET = 4_000_000;
/** Instructions one `<clinit>` may spend. Kept apart so a registry's own initialiser cannot starve the root. */
const CLINIT_BUDGET = 400000;
const CLINIT_FRAMES = 8000;
/** Instructions a constructor followed for its `super(...)` may spend. */
const CTOR_BUDGET = 40000;
/** Frames one root may open. `Blocks.<clinit>` inlines a few calls per block, for a thousand blocks. */
const FRAME_BUDGET = 60000;
const MAX_DEPTH = 14;
const MAX_ARRAY = 4096;
/** Times round a backward jump before a frame gives up on it. */
const MAX_ITERATIONS = 512;
const MAX_METHOD_HOPS = 8;
const STATIC = 0x00_08;

interface Shared {
	source: LightCodeSource;
	statics: Map<string, Value>;
	initialised: Set<string>;
	registrations: Map<string, Registration>;
	steps: number;
	frames: number;
	notes: string[];
	nextHandle: number;
	/** The state a light function is being evaluated against, or null outside an evaluation. */
	probe: StateProbe | null;
	/** Steps spent per call made directly from the root, so a run that spends its budget can say where. */
	frameCounts: Map<string, number>;
}

function isTracked(value: Value): boolean {
	return ['object', 'lambda', 'state'].includes(value.kind);
}

/** Whether a string could be a registry name: a path, or `namespace:path`. */
function looksLikeId(text: string): boolean {
	return /^[a-z0-9_.\-/]+(?::[a-z0-9_.\-/]+)?$/.test(text) && text.length < 128;
}

const LOAD_CONSTANT = new Set([0x12, 0x13, 0x14]);
const RETURNS = new Set([0xAC, 0xAD, 0xAE, 0xAF, 0xB0, 0xB1]);
const ARRAY_LOADS = new Set([0x2E, 0x2F, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35]);
const ARRAY_STORES = new Set([0x4F, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56]);
const INVOKES = new Set([0xB6, 0xB7, 0xB8, 0xB9]);
/** The wide (long/double) opcodes among the constants, loads and arithmetic, for stack bookkeeping. */
const WIDE_CONSTANTS = new Set([0x09, 0x0A, 0x0E, 0x0F, 0x14]);

/** Java `int` arithmetic: truncate, then wrap to 32 bits. */
function toInt(value: number): number {
	return Number.isFinite(value) ? Number(BigInt.asIntN(32, BigInt(Math.trunc(value)))) : 0;
}

function compare(op: number, difference: number): boolean {
	switch (op) {
		case 0x99:
		case 0x9F: {
			return difference === 0;
		}
		case 0x9A:
		case 0xA0: {
			return difference !== 0;
		}
		case 0x9B:
		case 0xA1: {
			return difference < 0;
		}
		case 0x9C:
		case 0xA2: {
			return difference >= 0;
		}
		case 0x9D:
		case 0xA3: {
			return difference > 0;
		}
		default: {
			return difference <= 0;
		}
	}
}

/** The method a call names, where the JVM would look: the owner, then its ancestors. */
function findMethod(
	source: LightCodeSource,
	owner: string,
	name: string,
	descriptor: string,
): { code: Uint8Array; classFile: ClassFile; accessFlags: number; } | null {
	let at: string | null = owner;
	for (let hops = 0; at && hops < MAX_METHOD_HOPS; hops++) {
		const classFile: ClassFile | null = source.resolve(at);
		if (!classFile) {
			return null;
		}
		const method = classFile.methods.find(candidate => candidate.name === name
			&& candidate.descriptor === descriptor
			&& candidate.code);
		if (method?.code) {
			return { code: method.code, classFile, accessFlags: method.accessFlags };
		}
		at = classFile.superClass ? source.remapClass(classFile.superClass) : null;
	}
	return null;
}

/** A method by name alone, for a loader extension a mod overrides; the descriptor is the loader's. */
function findMethodNamed(
	source: LightCodeSource,
	owner: string,
	name: string,
	argCount: number,
	returns: string,
): { code: Uint8Array; classFile: ClassFile; descriptor: string; } | null {
	let at: string | null = owner;
	for (let hops = 0; at && hops < MAX_METHOD_HOPS; hops++) {
		const classFile: ClassFile | null = source.resolve(at);
		if (!classFile) {
			return null;
		}
		const method = classFile.methods.find((candidate) => {
			if (candidate.name !== name || !candidate.code) {
				return false;
			}
			const shape = parseDescriptor(candidate.descriptor);
			return shape.args.length === argCount && shape.returns === returns;
		});
		if (method?.code) {
			return { code: method.code, classFile, descriptor: method.descriptor };
		}
		at = classFile.superClass ? source.remapClass(classFile.superClass) : null;
	}
	return null;
}

class Interpreter {
	private readonly stack: Value[] = [];
	private readonly locals = new Map<number, Value>();
	private readonly loops = new Map<number, number>();
	/**
	 * Whether a conditional since the last backward jump could not be decided. A loop whose head this
	 * cannot evaluate — `for (Block block : registry)` over an iterator it never saw — would otherwise
	 * fall through its exit test every time round and spin to the iteration cap, and two of them nested
	 * is the whole step budget.
	 */
	private undecided = false;
	private returned: Value | null = null;
	/** The class whose code this frame runs, for saying who made a registration. */
	private caller: string | null = null;
	private readonly shared: Shared;
	private readonly depth: number;

	constructor(shared: Shared, depth = 0) {
		this.shared = shared;
		this.depth = depth;
	}

	private handle(type: string | null): Handle {
		return {
			id: this.shared.nextHandle++,
			type,
			strings: [],
			numbers: [],
			classes: [],
			fields: new Map(),
			isProps: type !== null && this.isPropsType(type),
			light: null,
			props: null,
			ctorArgs: null,
		};
	}

	private isPropsType(name: string): boolean {
		const { propsClasses, remapClass } = this.shared.source;
		return propsClasses.has(name) || propsClasses.has(remapClass(name));
	}

	private note(message: string): void {
		if (!this.shared.notes.includes(message)) {
			this.shared.notes.push(message);
		}
	}

	private pop(): Value {
		return this.stack.pop() ?? UNKNOWN;
	}

	private push(value: Value | null): void {
		if (value) {
			this.stack.push(value);
		}
	}

	private number(value: Value): number {
		return value.kind === 'number' ? value.value : 0;
	}

	private isWide(value: Value): boolean {
		return value.kind === 'number' && value.wide === true;
	}

	/** Puts receiver and arguments where the callee reads them; longs and doubles take two slots. */
	private seed(receiver: Value | null, descriptor: string, args: Value[]): void {
		let slot = 0;
		if (receiver) {
			this.locals.set(slot++, receiver);
		}
		for (const [index, shape] of parseDescriptor(descriptor).args.entries()) {
			this.locals.set(slot, args[index] ?? UNKNOWN);
			slot += shape === 'J' || shape === 'D' ? 2 : 1;
		}
	}

	/** Copies the strings, numbers and classes that flowed through the arguments onto a result. */
	private taint(target: Handle, values: Value[]): void {
		for (const value of values) {
			if (target.strings.length > 64) {
				break;
			}
			if (value.kind === 'string') {
				target.strings.push(value.value);
			} else if (value.kind === 'number') {
				target.numbers.push(value.value);
			} else if (value.kind === 'class') {
				target.classes.push(value.name);
			} else if (value.kind === 'object' && value.handle !== target) {
				target.strings.push(...value.handle.strings);
				target.numbers.push(...value.handle.numbers);
				target.classes.push(...value.handle.classes);
				if (value.handle.builder) {
					target.strings.push(value.handle.builder.join(''));
				}
			}
		}
	}

	/** What an opaque call leaves behind, by its return type: nothing, a number, or a tainted object. */
	private opaqueResult(returns: string, inputs: Value[]): Value | null {
		if (returns === 'V') {
			return null;
		}
		if (returns.startsWith('L') || returns.startsWith('[')) {
			if (returns === 'Ljava/lang/String;') {
				// The last string in: `new ResourceLocation(namespace, path).getPath()` is the path
				const strings = inputs.flatMap(value => (value.kind === 'string'
					? [value.value]
					: (value.kind === 'object' ? value.handle.strings : [])));
				return strings.length > 0 ? { kind: 'string', value: strings.at(-1) as string } : UNKNOWN;
			}
			const created = this.handle(returns.startsWith('L') ? returns.slice(1, -1) : null);
			created.origin = `opaque ${returns} from ${inputs.map(value => value.kind).join(',')}`;
			this.taint(created, inputs);
			if (/(?:List|Set|Collection|Iterable);$/.test(returns)) {
				// `ImmutableList.of(a, b)`, `Lists.newArrayList(other)`: a list built from what went in
				const from = inputs.find(value => value.kind === 'array' || (value.kind === 'object' && value.handle.items));
				created.items = from?.kind === 'array'
					? [...from.items]
					: (from?.kind === 'object' ? [...from.handle.items ?? []] : inputs.filter(value => value.kind !== 'unknown'));
			}
			if (returns.endsWith('Map;')) {
				/*
				 * `ImmutableMap.copyOf(map)` and `Collections.unmodifiableMap(map)` hand back the same entries
				 * under a new object; `Map.of(k, v, …)` builds them from its pairs. Without this PipeBlock's
				 * property table came out empty and glow lichen could not find a face to glow from.
				 */
				const source = inputs.find(value => value.kind === 'object' && value.handle.map);
				if (source?.kind === 'object' && source.handle.map) {
					created.map = [...source.handle.map];
				} else if (inputs.length > 0 && inputs.length % 2 === 0 && inputs.every(value => value.kind !== 'unknown')) {
					created.map = [];
					for (let index = 0; index < inputs.length; index += 2) {
						created.map.push({ key: inputs[index], value: inputs[index + 1] });
					}
				}
			}
			// A copy of a block's properties made by a factory this cannot follow still copies its light
			if (created.isProps) {
				const sources = inputs.filter(value => value.kind === 'object' && (value.handle.isProps || value.handle.props));
				if (sources.length > 0) {
					const from = (sources[0] as { handle: Handle; }).handle;
					created.light = from.isProps ? from.light : from.props?.light ?? null;
					created.copyOf = from.isProps ? from : from.props;
				} else if (inputs.some(value => value.kind === 'unknown' || value.kind === 'null')) {
					created.light = { kind: 'opaque', reason: 'properties copied from a block the interpreter could not identify' };
				}
			}
			return { kind: 'object', handle: created };
		}
		return UNKNOWN;
	}

	/**
	 * Runs a class's `<clinit>` once, on its own budget and at its own depth.
	 *
	 * A registry class's initialiser is the point of the whole exercise, and a `getstatic` from it
	 * reaches sound types, map colours and — through `BuiltInRegistries` — the entire registry system.
	 * Each gets its own allowance so a sprawling one cannot spend what the block table needs.
	 *
	 * Its own depth, because an initialiser runs once and its results stand for the rest of the run:
	 * `Direction`'s was first reached fourteen frames down inside a codec builder, its `$values()` could
	 * not be followed from there, and every later read of `Direction.values()` was an opaque object.
	 */
	private initialise(owner: string): void {
		if (this.shared.initialised.has(owner)) {
			return;
		}
		this.shared.initialised.add(owner);
		const target = findMethod(this.shared.source, owner, '<clinit>', '()V');
		if (!target) {
			return;
		}
		const saved = { steps: this.shared.steps, frames: this.shared.frames, probe: this.shared.probe };
		this.shared.steps = CLINIT_BUDGET;
		this.shared.frames = CLINIT_FRAMES;
		// An initialiser reached from inside a light function is not the light function: its branches are its own
		this.shared.probe = null;
		try {
			new Interpreter(this.shared, 0).run(target.code, target.classFile);
		} finally {
			if (this.depth === 0) {
				const key = `${owner}.<clinit>`;
				this.shared.frameCounts.set(key, (this.shared.frameCounts.get(key) ?? 0) + (CLINIT_BUDGET - this.shared.steps));
			}
			this.shared.steps = saved.steps;
			this.shared.frames = saved.frames;
			this.shared.probe = saved.probe;
		}
	}

	private inline(
		owner: string,
		name: string,
		descriptor: string,
		receiver: Value | null,
		args: Value[],
	): { ok: true; value: Value | null; } | { ok: false; } {
		if (this.depth >= MAX_DEPTH || this.shared.frames <= 0) {
			return { ok: false };
		}
		const target = findMethod(this.shared.source, owner, name, descriptor);
		if (!target) {
			return { ok: false };
		}
		this.shared.frames--;
		const frame = new Interpreter(this.shared, this.depth + 1);
		frame.seed((target.accessFlags & STATIC) === 0 ? receiver : null, descriptor, args);
		const before = this.shared.steps;
		frame.run(target.code, target.classFile);
		if (this.depth === 0) {
			const key = `${owner}.${name}${descriptor}`;
			this.shared.frameCounts.set(key, (this.shared.frameCounts.get(key) ?? 0) + (before - this.shared.steps));
		}
		return { ok: true, value: frame.returned };
	}

	/** Applies a constructor to a fresh object: records what went in, and follows it for `super(...)`. */
	private construct(created: Handle, reference: MemberReference, args: Value[]): void {
		created.ctorArgs = args;
		this.taint(created, args);
		for (const arg of args) {
			if (arg.kind === 'object' && arg.handle.isProps) {
				created.props = arg.handle;
			}
		}
		if (created.type === 'java/lang/StringBuilder') {
			created.builder = args.flatMap(arg => (arg.kind === 'string' || arg.kind === 'number' ? [arg.value] : []));
			return;
		}
		if (created.type !== null && LIST_CLASSES.test(created.type)) {
			// `new ArrayList<>(other)` starts with the other's elements; `new ArrayList<>()` with none
			const from = args.find(arg => arg.kind === 'array' || (arg.kind === 'object' && arg.handle.items));
			created.items = from?.kind === 'array' ? [...from.items] : (from?.kind === 'object' ? [...from.handle.items ?? []] : []);
			return;
		}
		/*
		 * Followed only when no `Properties` came in: a block handed its properties has said all it will
		 * about light, and following the game's own `Block.<init>` builds a state definition through the
		 * codec machinery for nothing. A mod's `super(Properties.of().lightLevel(...))` is the case that
		 * needs following, and it takes none.
		 */
		if (created.props) {
			return;
		}
		const saved = this.shared.steps;
		this.shared.steps = Math.min(saved, CTOR_BUDGET);
		try {
			this.inline(reference.owner, reference.name, reference.descriptor, { kind: 'object', handle: created }, args);
		} finally {
			this.shared.steps = saved - Math.max(0, Math.min(saved, CTOR_BUDGET) - this.shared.steps);
		}
	}

	/**
	 * Runs a lambda with the values it captured followed by the arguments it is called with.
	 *
	 * A method reference to a constructor — `TorchBlock::new` — is a lambda too, and calling it
	 * constructs: which is how a 1.21.2+ factory hands the interpreter the block class.
	 */
	private invokeLambda(lambda: LambdaValue, args: Value[]): Value | null {
		const reference = this.shared.source.remap({ owner: lambda.owner, name: lambda.name, descriptor: lambda.descriptor }, false);
		const all = [...lambda.captured, ...args];
		if (reference.name === '<init>') {
			const created = this.handle(reference.owner);
			this.construct(created, reference, all);
			return { kind: 'object', handle: created };
		}
		const target = findMethod(this.shared.source, reference.owner, reference.name, reference.descriptor);
		if (!target) {
			return null;
		}
		// A bound reference captured its receiver first
		const [receiver, ...rest] = all;
		const result = (target.accessFlags & STATIC) === 0
			? this.inline(reference.owner, reference.name, reference.descriptor, receiver ?? UNKNOWN, rest)
			: this.inline(reference.owner, reference.name, reference.descriptor, null, all);
		return result.ok ? result.value : null;
	}


	/**
	 * A call whose arguments carry a name and a block (or its properties) is a registration, whatever
	 * it is called. Recorded first-come: a helper that registers on the caller's behalf fires first,
	 * from inside, and the outer call then agrees with it.
	 */
	/** Whether a handle is an enum constant, whose name-like strings (`"white"`) name nothing registered. */
	private isEnumConstant(handle: Handle): boolean {
		if (!handle.type || !handle.ctorArgs) {
			return false;
		}
		const classFile = this.shared.source.resolve(handle.type);
		const parent = classFile?.superClass ?? null;
		return parent === 'java/lang/Enum' || (parent !== null && this.shared.source.resolve(parent)?.superClass === 'java/lang/Enum');
	}

	private detectRegistration(args: Value[], site: string): Handle | null {
		const names: string[] = [];
		for (const arg of args) {
			if (arg.kind === 'string') {
				names.push(arg.value);
			} else if (arg.kind === 'object' && !arg.handle.props && !arg.handle.isProps && !this.isEnumConstant(arg.handle)) {
				// A block's own taint is what built it — a particle name, a base block — not what it is called
				names.push(...arg.handle.strings);
				if (arg.handle.builder) {
					names.push(arg.handle.builder.join(''));
				}
			}
		}
		const ids = names.filter(name => looksLikeId(name));
		if (ids.length === 0) {
			return null;
		}
		const known = ids.map(name => this.shared.registrations.get(name)).find(entry => entry !== undefined);
		if (known && ids.every(name => this.shared.registrations.has(name))) {
			return known.block ?? this.blockFor(known);
		}
		let props: Handle | null = null;
		let block: Handle | null = null;
		let blockType: string | null = null;
		for (const arg of args) {
			if (arg.kind === 'object' && arg.handle.isProps) {
				props ??= arg.handle;
			} else if (arg.kind === 'object' && arg.handle.props) {
				block ??= arg.handle;
			} else if (arg.kind === 'lambda' && arg.name === '<init>') {
				blockType ??= this.shared.source.remapClass(arg.owner);
			}
		}
		if (!props && !block) {
			// `register("name", () -> new Block(...))`: the block is behind a supplier, so run it
			for (const arg of args) {
				if (arg.kind !== 'lambda') {
					continue;
				}
				const made = this.invokeLambda(arg, []);
				if (made?.kind === 'object' && made.handle.props) {
					block = made.handle;
					break;
				}
			}
		}
		if (!props && !block) {
			return null;
		}
		const registration: Registration = {
			props: props ?? block?.props ?? null,
			block,
			blockType: blockType ?? block?.type ?? null,
			site,
			vanilla: this.caller !== null && this.shared.source.isVanillaClass(this.caller),
		};
		for (const name of ids) {
			if (!this.shared.registrations.has(name)) {
				this.shared.registrations.set(name, registration);
			}
		}
		return block ?? this.blockFor(registration);
	}

	/**
	 * The block a registration stands for, when the call was handed properties and a factory rather than
	 * a built block. What `Blocks.TORCH` then holds has to carry the properties, or a later
	 * `ofFullCopy(TORCH)` copies nothing.
	 */
	private blockFor(registration: Registration): Handle {
		if (registration.block) {
			return registration.block;
		}
		const created = this.handle(registration.blockType);
		created.props = registration.props;
		created.ctorArgs = [];
		registration.block = created;
		return created;
	}

	/** The property a `getValue` names, and the values it can take, from what flowed into its handle. */
	private domainOf(property: Handle): PropertyDomain | null {
		const name = property.strings.find(text => /^[a-z][a-z0-9_]*$/.test(text));
		if (!name) {
			this.note(`property ${property.type ?? '?'} carries no name: strings ${JSON.stringify(property.strings)} origin ${property.origin ?? (property.ctorArgs ? `new with ${property.ctorArgs.map(arg => arg.kind).join(',')}` : 'new, never constructed')} id ${property.id}`);
			return null;
		}
		const probe = this.shared.probe as StateProbe;
		const known = probe.domains.get(name);
		if (known) {
			return known;
		}
		/*
		 * The value class that flowed in: `Boolean.class` and `Integer.class` when `BooleanProperty.create`
		 * and `IntegerProperty.create` were followed into their constructors, an enum's class otherwise.
		 */
		const valueClass = property.classes.find(name => name !== 'java/lang/Boolean' && name !== 'java/lang/Integer');
		let domain: PropertyDomain;
		if (valueClass) {
			const constants = this.enumConstants(this.shared.source.remapClass(valueClass));
			if (constants.size === 0) {
				this.note(`enum ${valueClass} for property ${name} yielded no constants`);
				return null;
			}
			domain = { name, values: constants.keys().toArray(), constants };
		} else if (property.numbers.length >= 2 && !property.classes.includes('java/lang/Boolean')) {
			const [min, max] = property.numbers;
			if (max - min > 64) {
				return null;
			}
			const values: string[] = [];
			for (let value = min; value <= max; value++) {
				values.push(String(value));
			}
			domain = { name, values };
		} else {
			domain = { name, values: ['false', 'true'] };
		}
		probe.domains.set(name, domain);
		return domain;
	}

	/**
	 * An enum's constants by serialized name, in ordinal order.
	 *
	 * Each is an object its `<clinit>` constructed with `(name, ordinal, ...)`, and the name a blockstate
	 * writes is a lower-case constructor argument after those — or the constant's own name lowered where
	 * there is none.
	 */
	private enumConstants(owner: string): Map<string, Handle> {
		this.initialise(owner);
		const constants: Handle[] = [];
		for (const [key, value] of this.shared.statics) {
			if (!key.startsWith(`${owner}.`) || value.kind !== 'object' || !value.handle.ctorArgs) {
				continue;
			}
			// A constant with a body of its own is an anonymous subclass: `VaultState$1 extends VaultState`
			const type = value.handle.type;
			if (type === owner || (type !== null && this.shared.source.resolve(type)?.superClass === owner)) {
				constants.push(value.handle);
			}
		}
		constants.sort((left, right) => this.number(left.ctorArgs?.[1] ?? UNKNOWN) - this.number(right.ctorArgs?.[1] ?? UNKNOWN));
		const byName = new Map<string, Handle>();
		for (const constant of constants) {
			const args = constant.ctorArgs ?? [];
			const serialized = args.slice(2).find(arg => arg.kind === 'string' && /^[a-z][a-z0-9_]*$/.test(arg.value));
			const name = serialized?.kind === 'string'
				? serialized.value
				: (args[0]?.kind === 'string' ? args[0].value.toLowerCase() : `#${byName.size}`);
			byName.set(name, constant);
		}
		return byName;
	}

	/** `state.getValue(PROPERTY)` against the probe: the assigned value, or the first if none yet. */
	private readProperty(probe: StateProbe, property: Handle): Value {
		const domain = this.domainOf(property);
		if (!domain) {
			probe.failure = `reads a property the interpreter cannot resolve (${property.type ?? 'unknown class'})`;
			return UNKNOWN;
		}
		probe.reads.add(domain.name);
		const value = probe.values.get(domain.name) ?? domain.values[0];
		if (domain.constants) {
			const constant = domain.constants.get(value);
			return constant ? { kind: 'object', handle: constant } : UNKNOWN;
		}
		if (value === 'true' || value === 'false') {
			return { kind: 'number', value: value === 'true' ? 1 : 0 };
		}
		return { kind: 'number', value: Number(value) };
	}

	/** The handful of JDK calls a light function or a registry can lean on. */
	private jdkCall(reference: MemberReference, receiver: Value | null, args: Value[]): Value | null | undefined {
		const { owner, name } = reference;
		const numbers = args.map(arg => this.number(arg));
		if (owner === 'java/lang/Math') {
			switch (name) {
				case 'max': {
					return { kind: 'number', value: Math.max(...numbers) };
				}
				case 'min': {
					return { kind: 'number', value: Math.min(...numbers) };
				}
				case 'abs': {
					return { kind: 'number', value: Math.abs(numbers[0]) };
				}
				case 'floor': {
					return { kind: 'number', value: Math.floor(numbers[0]), wide: true };
				}
				case 'ceil': {
					return { kind: 'number', value: Math.ceil(numbers[0]), wide: true };
				}
				case 'round': {
					return { kind: 'number', value: Math.round(numbers[0]) };
				}
				default: {
					return undefined;
				}
			}
		}
		// Boxing and unboxing are identities here, numbers being numbers whichever side of the box
		if (/^java\/lang\/(?:Integer|Boolean|Float|Double|Long|Short|Byte|Character)$/.test(owner)) {
			if (name === 'valueOf' && args.length === 1) {
				return args[0];
			}
			if (receiver && name.endsWith('Value')) {
				return receiver;
			}
		}
		if (receiver?.kind === 'object' && receiver.handle.builder) {
			if (name === 'append') {
				const arg = args[0];
				if (arg?.kind === 'string' || arg?.kind === 'number') {
					receiver.handle.builder.push(arg.value);
				} else if (arg?.kind === 'object') {
					receiver.handle.builder.push(...arg.handle.strings.slice(-1));
				}
				return receiver;
			}
			if (name === 'toString') {
				return { kind: 'string', value: receiver.handle.builder.join('') };
			}
		}
		if (receiver?.kind === 'string' && reference.descriptor.endsWith('Ljava/lang/String;')) {
			/*
			 * A name built from a template: chipped's `"bright_%".replace("%", "acacia_planks")`, or
			 * `String.format("%s_slab", name)`. Anything else — toLowerCase, intern, trim — is near enough
			 * the same name.
			 */
			if ((name === 'replace' || name === 'replaceAll') && args.length === 2 && args[0].kind === 'string' && args[1].kind === 'string') {
				const replacement = args[1].value;
				return { kind: 'string', value: receiver.value.replaceAll(args[0].value, () => replacement) };
			}
			if (name === 'concat' && args[0]?.kind === 'string') {
				return { kind: 'string', value: receiver.value + args[0].value };
			}
			return receiver;
		}
		if (owner === 'java/lang/String' && name === 'format' && args[0]?.kind === 'string') {
			const operands = args[1]?.kind === 'array' ? args[1].items : args.slice(1);
			let index = 0;
			let known = true;
			const text = args[0].value.replaceAll(/%[sd]/g, () => {
				const value = operands[index++];
				if (value?.kind === 'string' || value?.kind === 'number') {
					return String(value.value);
				}
				known = false;
				return '';
			});
			return known ? { kind: 'string', value: text } : UNKNOWN;
		}
		if (receiver?.kind === 'array' && name === 'clone') {
			return { kind: 'array', items: [...receiver.items] };
		}
		/*
		 * Just enough of streams and collections for `Arrays.stream(DIRECTIONS).anyMatch(d ->
		 * hasFace(state, d))`, which is how glow lichen decides it has a face to glow from. A stream is
		 * the array it came from; the terminal operations run the predicate over it.
		 */
		if ((owner === 'java/util/Arrays' && (name === 'stream' || name === 'asList')) || ((owner === 'java/util/List' || owner === 'java/util/Set') && name === 'of')) {
			return args.length === 1 && args[0].kind === 'array' ? args[0] : { kind: 'array', items: args };
		}
		if (receiver?.kind === 'object' && receiver.handle.iterator) {
			const cursor = receiver.handle.iterator;
			if (name === 'hasNext') {
				return { kind: 'number', value: cursor.at < cursor.items.length ? 1 : 0 };
			}
			if (name === 'next') {
				return cursor.items[cursor.at++] ?? UNKNOWN;
			}
		}
		if (receiver?.kind === 'object' && receiver.handle.items && !receiver.handle.isProps) {
			const items = receiver.handle.items;
			if (name === 'add' && args.length === 1) {
				items.push(args[0]);
				return { kind: 'number', value: 1 };
			}
			if (name === 'addAll' && args.length === 1) {
				const more = args[0].kind === 'array' ? args[0].items : (args[0].kind === 'object' ? args[0].handle.items ?? [] : []);
				items.push(...more);
				return { kind: 'number', value: 1 };
			}
			if (name === 'get' && args.length === 1 && args[0].kind === 'number') {
				return items[args[0].value] ?? UNKNOWN;
			}
			if (name === 'size' || name === 'isEmpty') {
				return { kind: 'number', value: name === 'size' ? items.length : (items.length === 0 ? 1 : 0) };
			}
			if (name === 'iterator') {
				const created = this.handle('java/util/Iterator');
				created.iterator = { items, at: 0 };
				return { kind: 'object', handle: created };
			}
			if (['stream', 'toArray', 'toList', 'values', 'keySet'].includes(name)) {
				return { kind: 'array', items: [...items] };
			}
			if (name === 'forEach' && args[0]?.kind === 'lambda') {
				for (const item of items) {
					this.invokeLambda(args[0], [item]);
				}
				return null;
			}
		}
		if (receiver?.kind === 'array') {
			if (['stream', 'toList', 'collect', 'sorted', 'distinct'].includes(name)) {
				return receiver;
			}
			if (name === 'iterator') {
				const created = this.handle('java/util/Iterator');
				created.iterator = { items: receiver.items, at: 0 };
				return { kind: 'object', handle: created };
			}
			if (name === 'forEach' && args[0]?.kind === 'lambda') {
				for (const item of receiver.items) {
					this.invokeLambda(args[0], [item]);
				}
				return null;
			}
			if (name === 'map' && args[0]?.kind === 'lambda') {
				return { kind: 'array', items: receiver.items.map(item => this.invokeLambda(args[0] as LambdaValue, [item]) ?? UNKNOWN) };
			}
			if (name === 'filter' && args[0]?.kind === 'lambda') {
				const kept = receiver.items.filter((item) => {
					const verdict = this.invokeLambda(args[0] as LambdaValue, [item]);
					return verdict?.kind === 'number' ? verdict.value !== 0 : true;
				});
				return { kind: 'array', items: kept };
			}
			if (['anyMatch', 'allMatch', 'noneMatch'].includes(name) && args[0]?.kind === 'lambda') {
				const predicate = args[0];
				const results = receiver.items.map(item => this.invokeLambda(predicate, [item]));
				if (results.some(result => result?.kind !== 'number')) {
					return UNKNOWN;
				}
				const hits = results.filter(result => result?.kind === 'number' && result.value !== 0).length;
				let value = hits === 0;
				if (name === 'anyMatch') {
					value = hits > 0;
				} else if (name === 'allMatch') {
					value = hits === receiver.items.length;
				}
				return { kind: 'number', value: value ? 1 : 0 };
			}
			if (name === 'count' || name === 'size') {
				return { kind: 'number', value: receiver.items.length, wide: name === 'count' };
			}
		}
		return undefined;
	}

	/**
	 * A map the code fills and reads back, kept as its entries.
	 *
	 * `MultifaceBlock` decides whether glow lichen has any face through `PROPERTY_BY_DIRECTION.get(d)`,
	 * a map its initialiser filled from `Direction` to property. Keys compare as the JVM would: an enum
	 * constant is the same object, a string or number the same value.
	 */
	private mapCall(target: Handle, name: string, args: Value[]): Value | null | undefined {
		const same = (left: Value, right: Value): boolean => (left.kind === 'object' && right.kind === 'object'
			? left.handle === right.handle
			: (left.kind === 'string' || left.kind === 'number') && left.kind === right.kind && left.value === right.value);
		target.map ??= [];
		if (name === 'put' && args.length === 2) {
			const existing = target.map.find(entry => same(entry.key, args[0]));
			if (existing) {
				existing.value = args[1];
			} else {
				target.map.push({ key: args[0], value: args[1] });
			}
			return UNKNOWN;
		}
		if ((name === 'get' || name === 'getOrDefault') && args.length > 0) {
			return target.map.find(entry => same(entry.key, args[0]))?.value ?? args[1] ?? UNKNOWN;
		}
		if (name === 'containsKey' && args.length === 1) {
			return { kind: 'number', value: target.map.some(entry => same(entry.key, args[0])) ? 1 : 0 };
		}
		return undefined;
	}

	private call(reference: MemberReference, hasReceiver: boolean, special = false): void {
		const remapped = this.shared.source.remap(reference, false);
		const { args: shapes, returns } = parseDescriptor(remapped.descriptor);
		const args: Value[] = [];
		for (let index = 0; index < shapes.length; index++) {
			args.unshift(this.pop());
		}
		const receiver = hasReceiver ? this.pop() : null;
		const { source } = this.shared;

		// A functional interface called on a lambda runs the lambda — a `Consumer` for its effects alone
		if (receiver?.kind === 'lambda') {
			const result = this.invokeLambda(receiver, args);
			this.push(returns === 'V' ? null : result ?? UNKNOWN);
			return;
		}

		if (receiver?.kind === 'state') {
			const probe = receiver.probe;
			// getValue(property), hasProperty(property), and getValueOrElse(property, fallback)
			if ((args.length === 1 || args.length === 2) && args[0].kind === 'object' && !args[0].handle.isProps) {
				// getValue(Property), and the boolean hasProperty(Property) which is true for anything read
				if (returns === 'Z') {
					this.push({ kind: 'number', value: 1 });
					return;
				}
				this.push(this.readProperty(probe, args[0].handle));
				return;
			}
			probe.failure ??= `calls ${remapped.owner}.${remapped.name}${remapped.descriptor} on the state with (${args.map(arg => (arg.kind === 'object' ? `object ${arg.handle.type ?? '?'}` : arg.kind)).join(', ')}), which the interpreter does not model`;
			this.push(this.opaqueResult(returns, args));
			return;
		}

		if (receiver?.kind === 'object' && remapped.owner.endsWith('Map') && !receiver.handle.isProps) {
			const handled = this.mapCall(receiver.handle, remapped.name, args);
			if (handled !== undefined) {
				this.push(returns === 'V' ? null : handled);
				return;
			}
		}

		if (remapped.owner.startsWith('java/') || receiver?.kind === 'string' || receiver?.kind === 'number' || receiver?.kind === 'array'
			|| receiver?.kind === 'object' && (receiver.handle.builder || receiver.handle.items || receiver.handle.iterator)) {
			const handled = this.jdkCall(remapped, receiver, args);
			if (handled !== undefined) {
				this.push(returns === 'V' ? null : handled);
				return;
			}
			if (receiver?.kind === 'number' && args.length === 0) {
				// intValue(), booleanValue(), ordinal() on something already a number
				this.push(returns === 'V' ? null : receiver);
				return;
			}
			if (remapped.owner.startsWith('java/')) {
				this.push(this.opaqueResult(returns, receiver ? [receiver, ...args] : args));
				return;
			}
		}

		/*
		 * A registration is the end of the road: what it registers is known, and following it leads into
		 * the registry — holders, id maps, a `ResourceLocation` validated character by character — for a
		 * thousand blocks. That was the whole budget, spent on nothing this needs.
		 */
		const registered = this.detectRegistration(args, `${remapped.owner}.${remapped.name}${remapped.descriptor}`);
		if (registered) {
			this.push(returns === 'V' ? null : (returns.startsWith('L') ? { kind: 'object', handle: registered } : UNKNOWN));
			return;
		}

		if (receiver?.kind === 'object') {
			const target = receiver.handle;
			/*
			 * `OAK_PLANKS.defaultMapColor()`: a door takes its planks' colour, which is only on the planks'
			 * recorded calls, since the field the real method reads was never filled.
			 */
			const named = source.nameOf?.(reference, false) ?? remapped.name;
			if (target.props && args.length === 0 && (named === 'defaultMapColor' || named === 'defaultMaterialColor')) {
				const colour = statedMapColor(target.props);
				if (colour && colour.kind !== 'lambda') {
					this.push(colour);
					return;
				}
			}
			const getter = source.lightGetters.find(candidate => matchesGetter(candidate, remapped.name, remapped.descriptor));
			if (getter && target.props && args[0]?.kind === 'state') {
				/*
				 * The block's own light method. An override is followed like any call; the base — reached by
				 * `super.getLightValue(state)`, or because the class has no override — is the block's
				 * properties speaking, since the field it would read was never filled.
				 */
				const found = findGetter(source, target.type ?? remapped.owner, getter);
				const overridden = found !== null && found.classFile.thisClass !== getter.root && !special;
				if (!overridden) {
					const light = target.props.light;
					let answer: Value = UNKNOWN;
					if (light === null) {
						answer = { kind: 'number', value: 0 };
					} else if (light.kind === 'constant') {
						answer = { kind: 'number', value: light.level };
					} else if (light.kind === 'function') {
						answer = this.invokeLambda(light.fn, [args[0]]) ?? UNKNOWN;
					}
					this.push(answer);
					return;
				}
			}
			if (target.isProps) {
				if (shapes.length === 1 && shapes[0] === TO_INT_FUNCTION) {
					const fn = args[0];
					target.light = fn.kind === 'lambda'
						? { kind: 'function', fn }
						: { kind: 'opaque', reason: 'light function is a value the interpreter did not build' };
					this.push(returns === 'V' ? null : receiver);
					return;
				}
				if (shapes.length === 1 && shapes[0] === 'I' && this.isPropsType(returns.slice(1, -1))) {
					// lightValue(int), the 1.13–1.15 form; nothing else on Properties takes one int
					target.light = args[0].kind === 'number'
						? { kind: 'constant', level: args[0].value }
						: { kind: 'opaque', reason: 'light level is a value the interpreter did not compute' };
					this.push(receiver);
					return;
				}
				if (returns.startsWith('L') && this.isPropsType(returns.slice(1, -1))) {
					// Every other builder method: sound, strength, map colour — fluent, not about light, and kept for the block's behaviour
					const name = source.nameOf?.(reference, false) ?? remapped.name;
					(target.calls ??= []).push({ name: name === reference.name ? remapped.name : name, descriptor: remapped.descriptor, args });
					this.push(receiver);
					return;
				}
			}
			if (target.ctorArgs && args.length === 0 && (remapped.name === 'ordinal' || remapped.name === 'name')) {
				this.push(target.ctorArgs[remapped.name === 'ordinal' ? 1 : 0] ?? UNKNOWN);
				return;
			}
		}

		/*
		 * Follow the call when something tracked goes in or a `Properties` comes out; otherwise it is
		 * plumbing — `vanillaBlockId(String)`, a sound event lookup — and its result is the taint of its
		 * inputs. That keeps the interpreter out of `ResourceLocation`'s character validation loops.
		 */
		const returnsProps = returns.startsWith('L') && this.isPropsType(returns.slice(1, -1));
		/*
		 * A static `Properties` factory given a block or another `Properties` is a copy — `ofFullCopy`,
		 * `ofLegacyCopy`, the 1.13 `from` — and is answered as one rather than followed: the real method
		 * reads fields off the source block that this never filled, and would come back with nothing.
		 */
		if (returnsProps && !hasReceiver && args.some(arg => arg.kind === 'object' && (arg.handle.isProps || arg.handle.props))) {
			this.push(this.opaqueResult(returns, args));
			return;
		}
		/*
		 * Follow the call when something tracked goes in, a `Properties` comes out, or it is a plain
		 * helper on a class in the jars given constants — `stoneButton()`, `pistonBase(true)`, and 26.x's
		 * `createSimpleCopper("copper_bulb")`, which builds the record the copper registrations read
		 * their ids from. One given a value this never saw is left alone: its result is the taint of its
		 * inputs anyway.
		 */
		const helper = !hasReceiver
			&& !args.some(arg => arg.kind === 'unknown')
			&& ((returns.startsWith('L') && !returns.startsWith('Ljava/') && source.resolve(returns.slice(1, -1)) !== null)
				// `Direction.values()`: an array of the jar's own constants
				|| (returns.startsWith('[L') && source.resolve(remapped.owner) !== null)
				// `Mth.floor(f)`: a numeric helper, which a light function's arithmetic runs through
				|| (args.length > 0 && args.every(arg => arg.kind === 'number') && !returns.startsWith('L') && !returns.startsWith('[')));
		const follow = receiver?.kind === 'object' || args.some(arg => isTracked(arg)) || returnsProps || returns === TO_INT_FUNCTION || helper;
		if (follow) {
			const inlined = this.inline(remapped.owner, remapped.name, remapped.descriptor, receiver, args);
			if (inlined.ok) {
				this.push(returns === 'V' ? null : inlined.value ?? this.opaqueResult(returns, receiver ? [receiver, ...args] : args));
				return;
			}
		}
		// Outside the jars: `Properties.of()` is a fresh builder, `ofFullCopy(block)` copies its light
		this.push(this.opaqueResult(returns, receiver ? [receiver, ...args] : args));
	}

	/** Runs one method's code. Returns false when it stopped early. */
	run(code: Uint8Array, constants: ClassFile): boolean {
		this.caller = constants.thisClass;
		let at = 0;
		let wide = false;
		while (at < code.length) {
			if (this.shared.steps-- <= 0) {
				return false;
			}
			const op = code[at++];
			switch (true) {
				case op === 0x00: {
					break;
				}
				case op === 0x01: {
					this.push({ kind: 'null' });
					break;
				}
				case op >= 0x02 && op <= 0x08: {
					this.push({ kind: 'number', value: op - 0x03 });
					break;
				}
				case WIDE_CONSTANTS.has(op) && op !== 0x14: {
					this.push({ kind: 'number', value: op === 0x0A || op === 0x0F ? 1 : 0, wide: true });
					break;
				}
				case op >= 0x0B && op <= 0x0D: {
					this.push({ kind: 'number', value: op - 0x0B });
					break;
				}
				case op === 0x10: {
					this.push({ kind: 'number', value: (code[at++] << 24) >> 24 });
					break;
				}
				case op === 0x11: {
					this.push({ kind: 'number', value: (((code[at] << 8) | code[at + 1]) << 16) >> 16 });
					at += 2;
					break;
				}
				case LOAD_CONSTANT.has(op): {
					let index: number;
					if (op === 0x12) {
						index = code[at++];
					} else {
						index = (code[at] << 8) | code[at + 1];
						at += 2;
					}
					const entry = constants.constants[index];
					if (entry?.tag === 'class') {
						this.push({ kind: 'class', name: constants.utf8(index) });
						break;
					}
					const value = constants.literal(index);
					if (typeof value === 'string') {
						this.push({ kind: 'string', value });
					} else if (typeof value === 'number') {
						this.push({ kind: 'number', value, wide: op === 0x14 });
					} else if (typeof value === 'bigint') {
						this.push({ kind: 'number', value: Number(value), wide: true });
					} else {
						this.push(UNKNOWN);
					}
					break;
				}
				case op >= 0x15 && op <= 0x19: {
					// iload … aload with an index; `wide` widens the index to two bytes
					const index = wide ? (code[at] << 8) | code[at + 1] : code[at];
					at += wide ? 2 : 1;
					wide = false;
					this.push(this.locals.get(index) ?? UNKNOWN);
					break;
				}
				case op >= 0x1A && op <= 0x2D: {
					this.push(this.locals.get((op - 0x1A) % 4) ?? UNKNOWN);
					break;
				}
				case op >= 0x36 && op <= 0x3A: {
					const index = wide ? (code[at] << 8) | code[at + 1] : code[at];
					at += wide ? 2 : 1;
					wide = false;
					this.locals.set(index, this.pop());
					break;
				}
				case op >= 0x3B && op <= 0x4E: {
					this.locals.set((op - 0x3B) % 4, this.pop());
					break;
				}
				case ARRAY_LOADS.has(op): {
					const index = this.pop();
					const array = this.pop();
					const position = index.kind === 'number' ? index.value : -1;
					this.push(array.kind === 'array' ? array.items[position] ?? UNKNOWN : UNKNOWN);
					break;
				}
				case ARRAY_STORES.has(op): {
					const value = this.pop();
					const index = this.pop();
					const array = this.pop();
					if (array.kind === 'array' && index.kind === 'number' && index.value >= 0 && index.value < MAX_ARRAY) {
						array.items[index.value] = value;
					}
					break;
				}
				case op === 0x57: {
					this.pop();
					break;
				}
				case op === 0x58: {
					// pop2: one wide value or two narrow ones
					if (!this.isWide(this.pop())) {
						this.pop();
					}
					break;
				}
				case op === 0x59: {
					const top = this.pop();
					this.push(top);
					this.push(top);
					break;
				}
				case op === 0x5A: {
					const top = this.pop();
					const under = this.pop();
					this.push(top);
					this.push(under);
					this.push(top);
					break;
				}
				case op === 0x5B: {
					// dup_x2
					const top = this.pop();
					const second = this.pop();
					if (this.isWide(second)) {
						this.push(top);
					} else {
						const third = this.pop();
						this.push(top);
						this.push(third);
					}
					this.push(second);
					this.push(top);
					break;
				}
				case op === 0x5C: {
					// dup2
					const top = this.pop();
					if (this.isWide(top)) {
						this.push(top);
					} else {
						const second = this.pop();
						this.push(second);
						this.push(top);
						this.push(second);
					}
					this.push(top);
					break;
				}
				case op === 0x5D: {
					// dup2_x1: a wide value over one, or two narrow values over one
					const top = this.pop();
					const second = this.pop();
					if (this.isWide(top)) {
						this.push(top);
					} else {
						const third = this.pop();
						this.push(second);
						this.push(top);
						this.push(third);
					}
					this.push(second);
					this.push(top);
					break;
				}
				case op === 0x5E: {
					// dup2_x2, in its common forms: wide over wide, or wide over two narrow
					const top = this.pop();
					const second = this.pop();
					if (this.isWide(top)) {
						if (this.isWide(second)) {
							this.push(top);
						} else {
							const third = this.pop();
							this.push(top);
							this.push(third);
						}
					} else {
						const third = this.pop();
						if (this.isWide(third)) {
							this.push(second);
							this.push(top);
						} else {
							const fourth = this.pop();
							this.push(second);
							this.push(top);
							this.push(fourth);
						}
						this.push(third);
					}
					this.push(second);
					this.push(top);
					break;
				}
				case op === 0x5F: {
					const top = this.pop();
					const under = this.pop();
					this.push(top);
					this.push(under);
					break;
				}
				case op >= 0x60 && op <= 0x6F: {
					// add, sub, mul, div in fours: int, long, float, double
					const right = this.number(this.pop());
					const left = this.number(this.pop());
					const which = Math.floor((op - 0x60) / 4);
					const type = (op - 0x60) % 4;
					const integral = type <= 1;
					let value: number;
					switch (which) {
						case 0: {
							value = left + right;
							break;
						}
						case 1: {
							value = left - right;
							break;
						}
						case 2: {
							value = left * right;
							break;
						}
						default: {
							value = integral ? (right === 0 ? 0 : Math.trunc(left / right)) : left / right;
						}
					}
					if (type === 0) {
						value = toInt(value);
					}
					this.push({ kind: 'number', value, wide: type === 1 || type === 3 });
					break;
				}
				case op >= 0x70 && op <= 0x73: {
					const right = this.number(this.pop());
					const left = this.number(this.pop());
					const type = op - 0x70;
					this.push({ kind: 'number', value: right === 0 ? 0 : left % right, wide: type === 1 || type === 3 });
					break;
				}
				case op >= 0x74 && op <= 0x77: {
					const type = op - 0x74;
					this.push({ kind: 'number', value: -this.number(this.pop()), wide: type === 1 || type === 3 });
					break;
				}
				case op >= 0x78 && op <= 0x83: {
					// shifts and bitwise, int and long alternating
					const right = this.number(this.pop());
					const left = this.number(this.pop());
					const isLong = (op - 0x78) % 2 === 1;
					let value: number;
					switch (op) {
						case 0x78:
						case 0x79: {
							value = isLong ? left * 2 ** (right & 63) : left << (right & 31);
							break;
						}
						case 0x7A:
						case 0x7B: {
							value = isLong ? Math.floor(left / 2 ** (right & 63)) : left >> (right & 31);
							break;
						}
						case 0x7C:
						case 0x7D: {
							value = isLong ? Math.floor(left / 2 ** (right & 63)) : left >>> (right & 31);
							break;
						}
						case 0x7E:
						case 0x7F: {
							value = Number(BigInt(toInt(left)) & BigInt(toInt(right)));
							break;
						}
						case 0x80:
						case 0x81: {
							value = Number(BigInt(toInt(left)) | BigInt(toInt(right)));
							break;
						}
						default: {
							value = Number(BigInt(toInt(left)) ^ BigInt(toInt(right)));
						}
					}
					this.push({ kind: 'number', value, wide: isLong });
					break;
				}
				case op === 0x84: {
					const slot = wide ? (code[at] << 8) | code[at + 1] : code[at];
					const step = wide ? (((code[at + 2] << 8) | code[at + 3]) << 16) >> 16 : (code[at + 1] << 24) >> 24;
					at += wide ? 4 : 2;
					wide = false;
					this.locals.set(slot, { kind: 'number', value: this.number(this.locals.get(slot) ?? UNKNOWN) + step });
					break;
				}
				case op >= 0x85 && op <= 0x93: {
					// numeric conversions, with the truncation and widening they actually do
					const value = this.pop();
					if (value.kind !== 'number') {
						this.push(UNKNOWN);
						break;
					}
					let result = value.value;
					let isWide = false;
					switch (op) {
						case 0x85:
						case 0x8F: {
							isWide = true;
							break;
						}
						case 0x87:
						case 0x8A:
						case 0x8D: {
							isWide = true;
							break;
						}
						case 0x88:
						case 0x8B:
						case 0x8E: {
							result = toInt(result);
							break;
						}
						case 0x91: {
							result = (toInt(result) << 24) >> 24;
							break;
						}
						case 0x92: {
							result = toInt(result) & 0xFF_FF;
							break;
						}
						case 0x93: {
							result = (toInt(result) << 16) >> 16;
							break;
						}
						default: {
							break;
						}
					}
					this.push({ kind: 'number', value: result, wide: isWide });
					break;
				}
				case op >= 0x94 && op <= 0x98: {
					const right = this.pop();
					const left = this.pop();
					if (left.kind !== 'number' || right.kind !== 'number') {
						this.push(UNKNOWN);
						break;
					}
					this.push({ kind: 'number', value: Math.sign(left.value - right.value) });
					break;
				}
				case op >= 0x99 && op <= 0xA6: {
					const twoOperands = op >= 0x9F;
					const right = this.pop();
					const left = twoOperands ? this.pop() : { kind: 'number', value: 0 } as Value;
					const offset = (((code[at] << 8) | code[at + 1]) << 16) >> 16;
					at += 2;
					let decided: boolean | null = null;
					if (op >= 0xA5) {
						// if_acmpeq / if_acmpne: reference identity, which an enum comparison is
						let same: boolean | null = false;
						if (left.kind === 'object' && right.kind === 'object') {
							same = left.handle === right.handle;
						} else if (left.kind === 'null' && right.kind === 'null') {
							same = true;
						} else if (left.kind === 'unknown' || right.kind === 'unknown') {
							same = null;
						}
						if (same !== null) {
							decided = op === 0xA5 ? same : !same;
						}
					} else if (left.kind === 'number' && right.kind === 'number') {
						decided = compare(op, twoOperands ? left.value - right.value : right.value);
					}
					if (decided === null) {
						this.undecided = true;
						if (this.shared.probe) {
							this.shared.probe.failure ??= 'branches on a value the interpreter could not compute';
						}
						break;
					}
					if (decided) {
						at += offset - 3;
					}
					break;
				}
				case op === 0xC6 || op === 0xC7: {
					const value = this.pop();
					const offset = (((code[at] << 8) | code[at + 1]) << 16) >> 16;
					at += 2;
					if (value.kind === 'unknown') {
						this.undecided = true;
						break;
					}
					const isNull = value.kind === 'null';
					if (op === 0xC6 ? isNull : !isNull) {
						at += offset - 3;
					}
					break;
				}
				case op === 0xA7 || op === 0xC8: {
					const offset = op === 0xA7
						? (((code[at] << 8) | code[at + 1]) << 16) >> 16
						: (code[at] << 24) | (code[at + 1] << 16) | (code[at + 2] << 8) | code[at + 3];
					const size = op === 0xA7 ? 3 : 5;
					at += size - 1;
					if (offset > 0) {
						at += offset - size;
						break;
					}
					const site = at - size;
					const round = (this.loops.get(site) ?? 0) + 1;
					this.loops.set(site, round);
					if (this.undecided) {
						// The exit test was a guess, so going round again is one too; leave the loop where it is
						this.undecided = false;
						break;
					}
					if (round > MAX_ITERATIONS) {
						this.note(`a loop at ${site} went round more than ${MAX_ITERATIONS} times`);
						break;
					}
					at += offset - size;
					break;
				}
				case op === 0xAA || op === 0xAB: {
					// tableswitch / lookupswitch, padded to a four-byte boundary from the opcode
					const start = at - 1;
					let cursor = at;
					while ((cursor & 3) !== 0) {
						cursor++;
					}
					const int32 = (position: number): number => (code[position] << 24) | (code[position + 1] << 16) | (code[position + 2] << 8) | code[position + 3];
					const fallback = int32(cursor);
					cursor += 4;
					const key = this.pop();
					let target = fallback;
					if (op === 0xAA) {
						const low = int32(cursor);
						const high = int32(cursor + 4);
						cursor += 8;
						if (key.kind === 'number' && key.value >= low && key.value <= high) {
							target = int32(cursor + (key.value - low) * 4);
						}
						cursor += (high - low + 1) * 4;
					} else {
						const pairs = int32(cursor);
						cursor += 4;
						for (let pair = 0; pair < pairs; pair++) {
							const match = int32(cursor);
							if (key.kind === 'number' && key.value === match) {
								target = int32(cursor + 4);
							}
							cursor += 8;
						}
					}
					if (key.kind !== 'number') {
						this.undecided = true;
						if (this.shared.probe) {
							this.shared.probe.failure ??= 'switches on a value the interpreter could not compute';
						}
						at = cursor;
						break;
					}
					at = start + target;
					break;
				}
				case RETURNS.has(op): {
					if (op !== 0xB1) {
						this.returned = this.pop();
					}
					return true;
				}
				case op === 0xB2: {
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					const raw = constants.reference(index);
					if (!raw) {
						this.push(UNKNOWN);
						break;
					}
					const reference = this.shared.source.remap(raw, true);
					if (reference.owner === 'java/lang/Boolean' && (reference.name === 'TRUE' || reference.name === 'FALSE')) {
						this.push({ kind: 'number', value: reference.name === 'TRUE' ? 1 : 0 });
						break;
					}
					const key = `${reference.owner}.${reference.name}`;
					if (!this.shared.statics.has(key)) {
						this.initialise(reference.owner);
					}
					this.push(this.shared.statics.get(key) ?? UNKNOWN);
					break;
				}
				case op === 0xB3: {
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					const value = this.pop();
					const raw = constants.reference(index);
					if (raw) {
						const reference = this.shared.source.remap(raw, true);
						this.shared.statics.set(`${reference.owner}.${reference.name}`, value);
					}
					break;
				}
				case op === 0xB4: {
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					const target = this.pop();
					const reference = constants.reference(index);
					this.push(target.kind === 'object' && reference
						? target.handle.fields.get(reference.name) ?? UNKNOWN
						: UNKNOWN);
					break;
				}
				case op === 0xB5: {
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					const value = this.pop();
					const target = this.pop();
					const reference = constants.reference(index);
					if (target.kind === 'object' && reference) {
						target.handle.fields.set(reference.name, value);
						// Also by mapped name, so `block-behaviour.ts` can read a `Material`'s `replaceable` on any version
						const mapped = this.shared.source.nameOf?.(reference, true) ?? reference.name;
						if (mapped !== reference.name) {
							target.handle.fields.set(`mapped:${mapped}`, value);
						}
						if (value.kind === 'object' && value.handle.isProps) {
							target.handle.props = value.handle;
						}
					}
					break;
				}
				case INVOKES.has(op): {
					const index = (code[at] << 8) | code[at + 1];
					at += op === 0xB9 ? 4 : 2;
					const reference = constants.reference(index);
					if (!reference) {
						break;
					}
					if (op === 0xB7 && reference.name === '<init>') {
						const remapped = this.shared.source.remap(reference, false);
						const { args: shapes } = parseDescriptor(remapped.descriptor);
						const args: Value[] = [];
						for (let count = 0; count < shapes.length; count++) {
							args.unshift(this.pop());
						}
						const objectRef = this.pop();
						if (objectRef.kind === 'object') {
							if (objectRef.handle.ctorArgs === null) {
								this.construct(objectRef.handle, remapped, args);
							} else {
								// `super(...)` from inside a constructor already being followed
								this.taint(objectRef.handle, args);
								for (const arg of args) {
									if (arg.kind === 'object' && arg.handle.isProps) {
										objectRef.handle.props = arg.handle;
									}
								}
								this.inline(remapped.owner, remapped.name, remapped.descriptor, objectRef, args);
							}
						}
						break;
					}
					this.call(reference, op !== 0xB8, op === 0xB7);
					break;
				}
				case op === 0xBB: {
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					const type = this.shared.source.remapClass(constants.utf8(index));
					this.push({ kind: 'object', handle: this.handle(type) });
					break;
				}
				case op === 0xBC || op === 0xBD: {
					at += op === 0xBC ? 1 : 2;
					const length = this.pop();
					const size = length.kind === 'number' ? Math.min(Math.max(length.value, 0), MAX_ARRAY) : 0;
					this.push({ kind: 'array', items: Array.from({ length: size }, () => UNKNOWN) });
					break;
				}
				case op === 0xC5: {
					// multianewarray: a dimension count, then that many lengths
					at += 2;
					const dimensions = code[at++];
					for (let count = 0; count < dimensions; count++) {
						this.pop();
					}
					this.push({ kind: 'array', items: [] });
					break;
				}
				case op === 0xBE: {
					const array = this.pop();
					this.push(array.kind === 'array' ? { kind: 'number', value: array.items.length } : UNKNOWN);
					break;
				}
				case op === 0xBF: {
					return true;
				}
				case op === 0xC0: {
					at += 2;
					break;
				}
				case op === 0xC1: {
					at += 2;
					this.pop();
					this.push(UNKNOWN);
					break;
				}
				case op === 0xC2 || op === 0xC3: {
					this.pop();
					break;
				}
				case op === 0xC4: {
					wide = true;
					break;
				}
				case op === 0xBA: {
					const index = (code[at] << 8) | code[at + 1];
					at += 4;
					const site = constants.invokeDynamic(index);
					const { args: shapes, returns } = site ? parseDescriptor(site.descriptor) : { args: [], returns: 'V' };
					const captured: Value[] = [];
					for (let count = 0; count < shapes.length; count++) {
						captured.unshift(this.pop());
					}
					const row = constants.bootstrap(index);
					if (row?.factory?.name === 'makeConcatWithConstants') {
						// String concatenation: the recipe's placeholders are the operands, in order
						const recipe = row.args.find(argument => typeof argument === 'string') ?? '';
						let operand = 0;
						let known = true;
						const text = recipe.replaceAll('', () => {
							const value = captured[operand++];
							if (value?.kind === 'string' || value?.kind === 'number') {
								return String(value.value);
							}
							if (value?.kind === 'object' && value.handle.strings.length > 0) {
								return value.handle.strings.at(-1) as string;
							}
							known = false;
							return '';
						});
						this.push(known ? { kind: 'string', value: text } : UNKNOWN);
						break;
					}
					const target = constants.lambdaTarget(index);
					this.push(returns === 'V'
						? null
						: (target ? { kind: 'lambda', ...target, captured } : UNKNOWN));
					break;
				}
				default: {
					this.note(`unsupported opcode 0x${op.toString(16)} at ${at - 1}`);
					return false;
				}
			}
		}
		return true;
	}

	/** Runs a method as a root: unknown arguments, a fresh receiver for an instance method. */
	runRoot(method: { name: string; code: Uint8Array; accessFlags: number; descriptor: string; }, classFile: ClassFile): void {
		const receiver = (method.accessFlags & STATIC) === 0
			? { kind: 'object' as const, handle: this.handle(classFile.thisClass) }
			: null;
		this.seed(receiver, method.descriptor, []);
		try {
			const finished = this.run(method.code, classFile);
			if (!finished && (this.shared.steps <= 0 || this.shared.frames <= 0)) {
				const busiest = this.shared.frameCounts.entries().toArray()
					.toSorted((left, right) => right[1] - left[1])
					.slice(0, 6)
					.map(([key, count]) => `${key} ${count} steps`)
					.join(', ');
				this.note(`${classFile.thisClass}.${method.name} ran past the ${this.shared.steps <= 0 ? 'step' : 'frame'} budget; busiest: ${busiest}`);
			}
		} catch (err) {
			this.note(`${classFile.thisClass}: ${(err as Error).message}`);
		}
	}

	/** Runs a function of a block state against one state; null where the interpreter lost the value. */
	evaluateLambda(fn: LambdaValue, probe: StateProbe): Value | null {
		this.shared.probe = probe;
		this.shared.steps = STEP_BUDGET;
		this.shared.frames = FRAME_BUDGET;
		try {
			const result = this.invokeLambda(fn, [{ kind: 'state', probe }]);
			return probe.failure ? null : result;
		} finally {
			this.shared.probe = null;
		}
	}

	/** Evaluates a light spec against one state; null where the interpreter lost the value. */
	evaluate(spec: LightSpec, probe: StateProbe): number | null {
		this.shared.probe = probe;
		this.shared.steps = STEP_BUDGET;
		this.shared.frames = FRAME_BUDGET;
		try {
			const state: Value = { kind: 'state', probe };
			let result: Value | null;
			if (spec.kind === 'function') {
				result = this.invokeLambda(spec.fn, [state]);
			} else if (spec.kind === 'method') {
				const method = findMethod(this.shared.source, spec.owner, spec.getter.name, spec.getter.descriptor);
				if (!method) {
					return null;
				}
				const receiver: Value = spec.receiver ? { kind: 'object', handle: spec.receiver } : { kind: 'object', handle: this.handle(spec.owner) };
				const extra = parseDescriptor(spec.getter.descriptor).args.length - 1;
				const inlined = this.inline(method.classFile.thisClass, spec.getter.name, spec.getter.descriptor, receiver, [state, ...Array.from({ length: extra }, () => UNKNOWN)]);
				result = inlined.ok ? inlined.value : null;
			} else {
				return spec.kind === 'constant' ? spec.level : null;
			}
			if (probe.failure || result?.kind !== 'number' || !Number.isFinite(result.value)) {
				return null;
			}
			return Math.max(0, Math.min(15, Math.round(result.value)));
		} finally {
			this.shared.probe = null;
		}
	}
}

/** What one run over a set of registry classes found. */
export interface LightExtraction {
	registrations: Map<string, Registration>;
	notes: string[];
	/** The light a block emits, or why it could not be worked out. */
	lightOf: (blockId: string) => { light: BlockPackLight; } | { failure: string; };
	/** The registration the code made for a block, under its full id or its own side's bare path. */
	registrationOf: (blockId: string) => Registration | null;
	/**
	 * Runs a function of a block state once per combination of the properties it reads, folded like
	 * light: a number when every state agrees, a default and cases otherwise. `read` turns what the
	 * function returned into a number, or null when it is not one this can use.
	 */
	tabulate: (fn: LambdaValue, read: (value: Value) => number | null) => { value: BlockPackLight; } | { failure: string; };
	/** What was recorded for a block, for a person chasing a failure. */
	describe: (blockId: string) => string;
}

/** All combinations of the given properties' values, as assignments. */
function combinations(domains: PropertyDomain[]): Array<Map<string, string>> {
	let out: Array<Map<string, string>> = [new Map()];
	for (const domain of domains) {
		const next: Array<Map<string, string>> = [];
		for (const partial of out) {
			for (const value of domain.values) {
				next.push(new Map([...partial, [domain.name, value]]));
			}
		}
		out = next;
	}
	return out;
}

/** The largest state table a light function may need; anything bigger is not a real block. */
const MAX_STATES = 4096;

/**
 * Folds a table of (assignment → level) into the pack's shape: a number when every state agrees,
 * otherwise the commonest level as the default and the rest as cases, each stripped of the properties
 * that do not change its answer.
 */
function foldCases(table: Array<{ values: Map<string, string>; level: number; }>, properties: string[]): BlockPackLight {
	const levels = new Set(table.map(row => row.level));
	if (levels.size === 1) {
		return table[0].level;
	}
	const counts = new Map<number, number>();
	for (const row of table) {
		counts.set(row.level, (counts.get(row.level) ?? 0) + 1);
	}
	const fallback = [...counts].toSorted((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
	const key = (values: Map<string, string>, keep: string[]): string => keep.map(name => `${name}=${values.get(name)}`).join(',');
	const cases = new Map<string, { when: Record<string, string>; level: number; }>();
	for (const row of table) {
		if (row.level === fallback) {
			continue;
		}
		// Drop each property in turn if every row agreeing on the others has this level
		let keep = [...properties];
		for (const name of properties) {
			const without = keep.filter(other => other !== name);
			const agree = table.filter(other => key(other.values, without) === key(row.values, without));
			if (agree.every(other => other.level === row.level)) {
				keep = without;
			}
		}
		const when: Record<string, string> = {};
		const kept = properties.filter(name => keep.includes(name)).toSorted((left, right) => left.localeCompare(right));
		for (const name of kept) {
			when[name] = row.values.get(name) as string;
		}
		cases.set(key(row.values, keep), { when, level: row.level });
	}
	const order = (left: Record<string, string>, right: Record<string, string>): number => {
		for (const name of properties) {
			const [leftValue, rightValue] = [left[name] ?? '', right[name] ?? ''];
			const numeric = leftValue !== '' && rightValue !== '' && !Number.isNaN(Number(leftValue)) && !Number.isNaN(Number(rightValue));
			const difference = numeric ? Number(leftValue) - Number(rightValue) : leftValue.localeCompare(rightValue);
			if (difference !== 0) {
				return difference;
			}
		}
		return 0;
	};
	return {
		default: fallback,
		cases: cases.values().toArray().toSorted((left, right) => order(left.when, right.when)),
	};
}

/**
 * Runs the registry code of a set of classes and answers, per block, what it emits.
 *
 * `roots` are the classes whose methods register blocks; every method of each is run, because where
 * the registrations sit differs by era and mod — `<clinit>` for a modern registry, a static
 * `registerBlocks()` in 1.13, an instance `init()` in a mod. The order is `<clinit>` first, since the
 * others read what it set up.
 */
export function extractBlockLight(roots: readonly ClassFile[], source: LightCodeSource): LightExtraction {
	const shared: Shared = {
		source,
		statics: new Map(),
		initialised: new Set(),
		registrations: new Map(),
		steps: STEP_BUDGET,
		frames: FRAME_BUDGET,
		notes: [],
		nextHandle: 1,
		probe: null,
		frameCounts: new Map(),
	};
	for (const classFile of roots) {
		shared.initialised.add(classFile.thisClass);
		const methods = classFile.methods.filter(method => method.code)
			.toSorted((left, right) => Number(right.name === '<clinit>') - Number(left.name === '<clinit>'));
		for (const method of methods) {
			shared.steps = STEP_BUDGET;
			shared.frames = FRAME_BUDGET;
			shared.frameCounts.clear();
			new Interpreter(shared).runRoot(method as { name: string; code: Uint8Array; accessFlags: number; descriptor: string; }, classFile);
		}
	}

	/**
	 * The registration for a block: under its full id, or its bare path when the code that made it is the
	 * block's own side — the game's for `minecraft:`, a mod's for anything else.
	 */
	const registrationOf = (blockId: string): Registration | null => {
		const colon = blockId.indexOf(':');
		const namespace = colon === -1 ? 'minecraft' : blockId.slice(0, colon);
		const path = colon === -1 ? blockId : blockId.slice(colon + 1);
		const byPath = shared.registrations.get(path);
		const wantVanilla = namespace === 'minecraft';
		return shared.registrations.get(blockId)
			?? (byPath && byPath.vanilla === wantVanilla ? byPath : null);
	};

	const lightOf = (blockId: string): { light: BlockPackLight; } | { failure: string; } => {
		const registration = registrationOf(blockId);
		if (!registration) {
			return { failure: 'no registration found in the code; light unknown' };
		}
		let spec: LightSpec | null = registration.props?.light ?? null;
		// A block class that answers for itself overrides its properties: a 1.13 furnace, a mod's own rule
		if (registration.blockType) {
			for (const getter of source.lightGetters) {
				const found = findGetter(source, registration.blockType, getter);
				if (found && found.classFile.thisClass !== getter.root) {
					spec = { kind: 'method', owner: registration.blockType, getter: { ...getter, descriptor: found.descriptor }, receiver: registration.block };
					break;
				}
			}
		}
		if (spec === null) {
			/*
			 * No properties at all is not the same as properties with no light: a block built on a
			 * builder the interpreter never recognised — a Fabric jar's `FabricBlockSettings`, an
			 * intermediary-mapped `Properties` — would otherwise be answered with a confident zero.
			 */
			if (registration.props === null) {
				return { failure: `registered without a recognisable properties builder (at ${registration.site}); light unknown` };
			}
			return { light: 0 };
		}
		if (spec.kind === 'constant') {
			return { light: Math.max(0, Math.min(15, Math.round(spec.level))) };
		}
		if (spec.kind === 'opaque') {
			return { failure: `light could not be read: ${spec.reason}` };
		}
		const evaluator = new Interpreter(shared);
		const folded = tabulateStates(shared, probe => evaluator.evaluate(spec, probe), 'light function');
		return 'failure' in folded ? folded : { light: folded.value };
	};

	const tabulate = (fn: LambdaValue, read: (value: Value) => number | null): { value: BlockPackLight; } | { failure: string; } => {
		const evaluator = new Interpreter(shared);
		return tabulateStates(shared, (probe) => {
			const value = evaluator.evaluateLambda(fn, probe);
			return value === null ? null : read(value);
		}, 'state function');
	};

	const describe = (blockId: string): string => {
		const registration = registrationOf(blockId);
		if (!registration) {
			return `${blockId}: not registered`;
		}
		const light = registration.props?.light;
		return `${blockId}: registered at ${registration.site}; class ${registration.blockType ?? '?'}, properties ${registration.props ? `#${registration.props.id}` : 'none'}, light ${light ? (light.kind === 'function' ? `function ${light.fn.owner}.${light.fn.name}${light.fn.descriptor}` : JSON.stringify(light)) : 'unset'}`;
	};

	return { registrations: shared.registrations, notes: shared.notes, lightOf, registrationOf, tabulate, describe };
}

/**
 * Runs `evaluate` over every combination of the properties it turns out to read, discovering them as
 * it goes: the first round runs with none, and each round adds whatever the last one read.
 */
function tabulateStates(
	shared: Shared,
	evaluate: (probe: StateProbe) => number | null,
	what: string,
): { value: BlockPackLight; } | { failure: string; } {
	const domains = new Map<string, PropertyDomain>();
	let properties: string[] = [];
	for (let rounds = 0; rounds < 8; rounds++) {
		const table: Array<{ values: Map<string, string>; level: number; }> = [];
		const discovered = new Set<string>();
		const assignments = combinations(properties.map(name => domains.get(name) as PropertyDomain));
		if (assignments.length > MAX_STATES) {
			return { failure: `${what} depends on ${assignments.length} states; too many to be a real block` };
		}
		for (const values of assignments) {
			const probe: StateProbe = { values, domains, reads: new Set(), failure: null };
			const before = shared.notes.length;
			const level = evaluate(probe);
			if (level === null) {
				const detail = shared.notes.slice(before).join('; ');
				return { failure: `${what} ${probe.failure ?? 'did not return a number'}${detail ? ` (${detail})` : ''}` };
			}
			table.push({ values, level });
			for (const read of probe.reads) {
				if (!properties.includes(read)) {
					discovered.add(read);
				}
			}
		}
		if (discovered.size === 0) {
			return { value: foldCases(table, properties) };
		}
		properties = [...properties, ...discovered];
	}
	return { failure: `${what} reads more properties than a blockstate can have` };
}
