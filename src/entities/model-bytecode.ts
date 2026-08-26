/**
 * Abstract interpretation of a boxy-model builder, enough to recover the geometry.
 *
 * The whole premise of the entity-geometry extractor: entity models are Java code, but the code is a
 * straight line of constant-argument calls into a tiny builder vocabulary. Vanilla 1.17+ builds a
 * `MeshDefinition` of `PartDefinition`s from `CubeListBuilder`s; pre-1.17 vanilla and most mods poke
 * `ModelRenderer`-alikes directly. Both are the same eight operations.
 *
 * Calls are classified by **descriptor shape, not class name**. That is what makes one interpreter
 * cover obfuscated vanilla (`fyp.a(FFFFFF)Lfyp;`) and a mod shipping its own copy of the API
 * (`AdvancedModelBox.addBox(FFFFFFFZ)V`) without a mapping file or a per-mod table.
 *
 * Conditionals are taken and recorded. A model builder's branches are all on a constructor argument —
 * a `CubeDeformation`, a baby-variant flag — so every arm builds a real shape and the fall-through is
 * one of them; the note says so. A *loop* is refused outright, because following it would emit the
 * same boxes twice or spin, and a wrong shape is worse than a recorded gap.
 */

import { parseClassFile } from './classfile.ts';
import { buildsOwnMesh, cubesOf, mergeModels } from './merge.ts';

import type { ClassFile } from './classfile.ts';
import type { Cube, ExtractedModel, Part } from './model.ts';

/** Argument slot count and shape of a descriptor's parameter list. */
function parseDescriptor(descriptor: string): { args: string[]; returns: string; } {
	const args: string[] = [];
	let at = 1;
	while (descriptor[at] !== ')') {
		const start = at;
		while (descriptor[at] === '[') {
			at++;
		}
		if (descriptor[at] === 'L') {
			at = descriptor.indexOf(';', at) + 1;
		} else {
			at++;
		}
		args.push(descriptor.slice(start, at));
	}
	return { args, returns: descriptor.slice(at + 1) };
}

/** An abstract value on the operand stack. */
type Value =
	| { kind: 'number'; value: number; }
	| { kind: 'string'; value: string; }
	| { kind: 'object'; handle: Handle; }
	| { kind: 'array'; items: Value[]; }
	/** A lambda, as the method that runs when something calls it. */
	| { kind: 'lambda'; owner: string; name: string; descriptor: string; }
	| { kind: 'unknown'; };

/** A tracked object: a part under construction, a cube builder, or a pose. */
interface Handle {
	id: number;
	/** Cubes accumulated by a builder, or belonging to a part. */
	cubes: Cube[];
	children: Handle[];
	name?: string;
	pivot?: [number, number, number];
	rotation?: [number, number, number];
	/** The texture offset the next `addBox` will use. */
	pendingUv: [number, number];
	pendingInflate: number;
	pendingMirror: boolean;
	/** Set when this handle is the root of a mesh. */
	isRoot?: boolean;
	/**
	 * Set once a handle has been folded into something else — a cube builder whose boxes were copied
	 * into a part, or a pose that was applied to one. Without this those handles look like roots,
	 * because nothing adopted them as children, and every part comes out twice.
	 */
	consumed?: boolean;
	/**
	 * A part built for a parent the interpreter could not identify — the mesh came from another class.
	 * It keeps its own pose and becomes a root, which is the most that can honestly be said about it.
	 */
	orphaned?: boolean;
	/** Whether `pendingUv` came from `new ModelRenderer(this, x, y)`, which is authoritative. */
	uvFromConstructor?: boolean;
	/**
	 * How far a `CubeDeformation` grows a box, for the handle that *is* one.
	 *
	 * It has to be carried on the handle because a deformation is an object: `new CubeDeformation(0.5)`
	 * passed to `addBox` is where an overlay layer gets the room it needs to sit outside the body it
	 * covers. Read as zero, an illager's robe lands exactly on its chest and the two z-fight.
	 */
	deformation?: number;
}

const NUMERIC = new Set(['F', 'D', 'I', 'J', 'S', 'B', 'C']);

/**
 * Whether a conditional jump is taken, for the opcodes that compare numbers.
 *
 * The single-operand forms (`ifeq` … `ifle`) test against zero and the two-operand forms (`if_icmpeq`
 * …) against each other, so both reduce to the sign of `left - right`.
 */
function compare(op: number, left: number, right: number): boolean {
	const difference = left - right;
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

/** Every entity sheet is a power of two, at least 16 in each direction. A texture offset rarely is. */
function isSheetSize(width: number, height: number): boolean {
	const power = (value: number): boolean => value >= 16 && (value & (value - 1)) === 0;
	return power(width) && power(height);
}

/** `ldc`, `ldc_w`, `ldc2_w`: a constant, narrow or wide index. */
const LOAD_CONSTANT = new Set([0x12, 0x13, 0x14]);

/** `lconst_0`/`lconst_1` and `dconst_0`/`dconst_1`, which push 0 and 1. */
const LONG_OR_DOUBLE_CONSTANT = new Set([0x09, 0x0A, 0x0E, 0x0F]);

/** Every `return` that ends a method, with or without a value. */
const RETURNS = new Set([0xAC, 0xAD, 0xAE, 0xAF, 0xB0, 0xB1]);

/**
 * Every array load: reading back an element of an array the builder filled. All eight, because
 * missing one costs a whole model — `daload` alone was the ender dragon.
 */
const ARRAY_LOADS = new Set([0x2E, 0x2F, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35]);

/** Every array store, the mirror of `ARRAY_LOADS`: `dastore` alone was the silverfish. */
const ARRAY_STORES = new Set([0x4F, 0x50, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56]);

/** The four invoke forms. `invokeinterface` carries two extra bytes; `invokestatic` has no receiver. */
const INVOKES = new Set([0xB6, 0xB7, 0xB8, 0xB9]);

/** Field names a model writes its texture dimensions to, across the eras and the loader APIs. */
const TEXTURE_WIDTH_FIELDS = new Set(['texWidth', 'textureWidth']);
const TEXTURE_HEIGHT_FIELDS = new Set(['texHeight', 'textureHeight']);

/** Deep enough for `<init>` → `super()` → `super()` and the static factories that mirror it. */
const MAX_INLINE_DEPTH = 5;
/** Frames per method. A model spends a handful; the cap is there so a strange jar cannot spend all day. */
const INLINE_BUDGET = 96;

/**
 * Instructions per extraction, shared across every frame.
 *
 * A model builder is a few hundred instructions and the longest vanilla loop runs a few thousand, so
 * this is two orders of magnitude of headroom — and it is what makes following a backward goto safe: a
 * loop whose bound cannot be worked out stops here instead of spinning.
 */
const STEP_BUDGET = 200000;

/** Elements tracked per array. A table of segment sizes is a handful; nothing here needs thousands. */
const MAX_ARRAY = 1024;

/** Times round a loop. Vanilla's longest builds sixteen segments, so this is generous by four times. */
const MAX_ITERATIONS = 64;
/** How far up a hierarchy to look for an inherited method, which is as deep as a model hierarchy goes. */
const MAX_METHOD_HOPS = 6;

/**
 * What every frame of one extraction shares. Fields especially: a superclass constructor assigns
 * `this.head` and the subclass overwrites it, which is the whole of how a pre-1.17 model is composed.
 */
interface Shared {
	handles: Handle[];
	fields: Map<string, Value>;
	notes: string[];
	textureSize: [number, number];
	/** Whether a conditional was taken, so the caller can say the shape is one of several. */
	branched: boolean;
	nextHandle: number;
	/** The class a call may be followed into, or null for the builder API and everything outside. */
	resolve: (internalName: string) => ClassFile | null;
	/** Nested frames left to spend, so a wide hierarchy cannot turn a 7 ms jar into a slow one. */
	budget: number;
	/**
	 * Static fields, by `owner.name`.
	 *
	 * A model that builds a row of segments keeps their sizes in a `static final int[][]` and indexes it
	 * by the loop counter — `SilverfishModel`, `EndermiteModel` and `BlazeModel` all do. Without the
	 * table those boxes come out at size zero, which is a blaze with no rods.
	 */
	statics: Map<string, Value>;
	/** Classes whose `<clinit>` has been run, so the tables above are filled exactly once. */
	initialised: Set<string>;
	/** Instructions left to run, which is what bounds a loop this cannot work the end of out. */
	steps: number;
}

function newShared(resolve: (internalName: string) => ClassFile | null): Shared {
	return {
		handles: [],
		fields: new Map(),
		notes: [],
		textureSize: [64, 32],
		branched: false,
		nextHandle: 1,
		resolve,
		budget: INLINE_BUDGET,
		statics: new Map(),
		initialised: new Set(),
		steps: STEP_BUDGET,
	};
}

/** The method a call names, looked up where the JVM would look: the owner, then up its ancestors. */
function findMethod(
	resolve: (internalName: string) => ClassFile | null,
	owner: string,
	name: string,
	descriptor: string,
): { code: Uint8Array; classFile: ClassFile; } | null {
	let at: string | null = owner;
	for (let hops = 0; at && hops < MAX_METHOD_HOPS; hops++) {
		const classFile: ClassFile | null = resolve(at);
		if (!classFile) {
			return null;
		}
		const method = classFile.methods.find(candidate => candidate.name === name
			&& candidate.descriptor === descriptor
			&& candidate.code);
		if (method?.code) {
			return { code: method.code, classFile };
		}
		at = classFile.superClass;
	}
	return null;
}

class Interpreter {
	private readonly stack: Value[] = [];
	private readonly locals = new Map<number, Value>();
	private readonly shared: Shared;
	private readonly depth: number;
	/** How many times each backward jump has been taken, so an undecidable loop cannot spin. */
	private readonly loops = new Map<number, number>();
	/** What this frame returned, for the caller that inlined it. */
	private returned: Value | null = null;

	constructor(shared: Shared, depth = 0) {
		this.shared = shared;
		this.depth = depth;
	}

	private handle(): Handle {
		const created: Handle = {
			id: this.shared.nextHandle++,
			cubes: [],
			children: [],
			pendingUv: [0, 0],
			pendingInflate: 0,
			pendingMirror: false,
		};
		this.shared.handles.push(created);
		return created;
	}

	/** Puts the receiver and arguments where the callee's bytecode reads them; longs take two slots. */
	private seed(receiver: Value | null, descriptor: string, args: Value[]): void {
		let slot = 0;
		if (receiver) {
			this.locals.set(slot++, receiver);
		}
		for (const [index, shape] of parseDescriptor(descriptor).args.entries()) {
			this.locals.set(slot, args[index] ?? { kind: 'unknown' });
			slot += shape === 'J' || shape === 'D' ? 2 : 1;
		}
	}

	/**
	 * Runs a class's `<clinit>` once, so its static tables can be read.
	 *
	 * Only for model code, and only once per class per extraction: the point is a table of numbers, and
	 * anything else a static initialiser does is of no interest here.
	 */
	private initialise(owner: string): void {
		if (this.shared.initialised.has(owner) || this.depth >= MAX_INLINE_DEPTH) {
			return;
		}
		this.shared.initialised.add(owner);
		const target = findMethod(this.shared.resolve, owner, '<clinit>', '()V');
		if (!target) {
			return;
		}
		new Interpreter(this.shared, this.depth + 1).run(target.code, target.classFile);
	}

	/**
	 * Interprets a call into the model's own code, with the arguments it was actually given.
	 *
	 * This is what makes an inherited part come out right. `CowModel` calls `super(12, 0)` and the legs
	 * it inherits are `addBox(-2, 0, -2, 4, cubeHeight, 4)`: without the 12 they are boxes of height
	 * zero, and a cow with four invisible legs looks exactly like a bug in the mesher.
	 *
	 * Restricted to model code on purpose. The builder API is in the same jar, and `CubeListBuilder`
	 * must keep its abstract treatment rather than being followed into.
	 */
	private inline(
		owner: string,
		name: string,
		descriptor: string,
		receiver: Value | null,
		args: Value[],
	): Value | null {
		if (this.depth >= MAX_INLINE_DEPTH || this.shared.budget <= 0) {
			return null;
		}
		const target = findMethod(this.shared.resolve, owner, name, descriptor);
		if (!target) {
			return null;
		}
		this.shared.budget--;
		const frame = new Interpreter(this.shared, this.depth + 1);
		frame.seed(receiver, descriptor, args);
		// A frame that gave up part way still built something, and its boxes are already in `shared`
		return frame.run(target.code, target.classFile) ? frame.returned : null;
	}

	/** Records a note once, since every candidate method would otherwise repeat it. */
	private note(message: string): void {
		if (!this.shared.notes.includes(message)) {
			this.shared.notes.push(message);
		}
	}

	private pop(): Value {
		return this.stack.pop() ?? { kind: 'unknown' };
	}

	private number(value: Value): number {
		return value.kind === 'number' ? value.value : 0;
	}

	/**
	 * Applies one call. Everything is decided by the descriptor: how many arguments to take, whether
	 * there is a receiver, and which of the builder operations the shape corresponds to.
	 */
	private call(owner: string, name: string, descriptor: string, hasReceiver: boolean): void {
		const { args, returns } = parseDescriptor(descriptor);
		const taken: Value[] = [];
		for (let index = args.length - 1; index >= 0; index--) {
			taken.unshift(this.pop());
		}
		const receiver = hasReceiver ? this.pop() : null;
		const target = receiver?.kind === 'object' ? receiver.handle : null;
		const numbers = taken.map(value => this.number(value));
		const floats = args.filter(arg => NUMERIC.has(arg)).length;

		/*
		 * texOffs(int, int) / setTextureOffset(int, int).
		 *
		 * Before 1.17 a part takes *two* `(int, int)` calls — the offset and `setTexSize`, the sheet the
		 * offset is in — and an obfuscated jar renames both of them to `a`, so the descriptor cannot tell
		 * them apart. What can: in that era the offset came from the part's constructor already, so a pair
		 * that looks like a sheet size is the other call. Which is worth having rather than discarding,
		 * because it is the only statement of the sheet size a pre-1.17 model makes.
		 */
		if (args.length === 2 && args.every(arg => arg === 'I') && target) {
			const known = taken.every(value => value.kind === 'number');
			if (known && target.uvFromConstructor && isSheetSize(numbers[0], numbers[1])) {
				this.shared.textureSize = [numbers[0], numbers[1]];
			} else if (known) {
				target.pendingUv = [numbers[0], numbers[1]];
			}
			this.push(returns === 'V' ? null : receiver);
			return;
		}

		/*
		 * addBox(x, y, z, w, h, d, [inflate], [mirror]) — six numbers, then optional extras.
		 *
		 * There is also a **named** overload, `addBox(String, x, y, z, w, h, d)`, which labels one box
		 * inside a part: a cow's head declares its two horns that way. Rejecting it did not merely lose
		 * the horns — it broke the fluent chain, so the `CubeListBuilder` the rest of the head was on
		 * became an unknown value and the whole head fell out unnamed, at the origin, with no pose.
		 */
		const named = args[0] === 'Ljava/lang/String;' && floats >= 6 && args.length >= 7 && NUMERIC.has(args[6]);
		const first = named ? 1 : 0;
		if (target && (named || (floats >= 6 && args.length >= 6 && NUMERIC.has(args[0]) && NUMERIC.has(args[5])))) {
			/*
			 * How much the box grows, from whichever of the three ways this call states it.
			 *
			 * The trap is that `delta` is not the only thing that can follow the six numbers. There is an
			 * old overload `addBox(name, x, y, z, w, h, d, delta, texU, texV)`, and taking the *first* extra
			 * number regardless of type read a **texture coordinate** as an inflate: the ender dragon's
			 * boxes came out grown by 176 pixels — eleven blocks — which is the black slab the gallery drew
			 * where a dragon should be. A delta is always a float; texture coordinates are always ints.
			 */
			const extra = args.slice(first + 6);
			const floatAt = extra.findIndex(arg => arg === 'F' || arg === 'D');
			const deformed = taken.find(value => value.kind === 'object' && value.handle.deformation !== undefined);
			let inflate = target.pendingInflate;
			if (floatAt !== -1) {
				inflate = this.number(taken[first + 6 + floatAt]);
			} else if (deformed?.kind === 'object') {
				inflate = deformed.handle.deformation ?? 0;
			}
			target.cubes.push({
				origin: [numbers[first], numbers[first + 1], numbers[first + 2]],
				size: [numbers[first + 3], numbers[first + 4], numbers[first + 5]],
				uv: [...target.pendingUv],
				inflate,
				mirror: target.pendingMirror || (extra.includes('Z') && this.number(taken[args.length - 1]) === 1),
			});
			this.push(returns === 'V' ? null : receiver);
			return;
		}

		// setRotationPoint(x, y, z) on a part, or a static PartPose.offset(x, y, z)
		if (args.length === 3 && args.every(arg => NUMERIC.has(arg))) {
			if (target) {
				target.pivot = [numbers[0], numbers[1], numbers[2]];
				this.push(returns === 'V' ? null : receiver);
			} else {
				const pose = this.handle();
				pose.pivot = [numbers[0], numbers[1], numbers[2]];
				this.push({ kind: 'object', handle: pose });
			}
			return;
		}

		// PartPose.offsetAndRotation(x, y, z, xRot, yRot, zRot), static
		if (args.length === 6 && args.every(arg => NUMERIC.has(arg)) && !target) {
			const pose = this.handle();
			pose.pivot = [numbers[0], numbers[1], numbers[2]];
			pose.rotation = [numbers[3], numbers[4], numbers[5]];
			this.push({ kind: 'object', handle: pose });
			return;
		}

		/*
		 * addOrReplaceChild(String, CubeListBuilder, PartPose).
		 *
		 * The receiver may be unknown, and often is: a model that builds on a mesh handed to it by
		 * another class — `CowModel` adds its head to the root `QuadrupedModel.createBodyMesh` returned —
		 * calls this on a value no interpretation produced. The child is still built either way, and only
		 * its *parent* is lost, so it becomes a root of its own.
		 *
		 * The alternative was letting the raw builder fall out as a root. That kept the boxes but dropped
		 * the pose with them, so a cow's head drew at the origin instead of on its neck.
		 */
		if (args.length === 3 && args[0] === 'Ljava/lang/String;' && taken[1].kind === 'object') {
			const child = this.handle();
			child.name = taken[0].kind === 'string' ? taken[0].value : `part${child.id}`;
			const builder = taken[1].handle;
			const pose = taken[2].kind === 'object' ? taken[2].handle : null;
			child.cubes = [...builder.cubes];
			child.pivot = pose?.pivot ?? [0, 0, 0];
			child.rotation = pose?.rotation ?? [0, 0, 0];
			builder.consumed = true;
			if (pose) {
				pose.consumed = true;
			}
			if (target) {
				// It is named addOrReplace: a subclass swapping one part of an inherited mesh relies on it
				const existing = target.children.findIndex(sibling => sibling.name === child.name);
				if (existing === -1) {
					target.children.push(child);
				} else {
					target.children[existing].consumed = true;
					target.children[existing] = child;
				}
			} else {
				child.orphaned = true;
			}
			this.push({ kind: 'object', handle: child });
			return;
		}

		/*
		 * Something being handed a lambda and a mesh is a `MeshTransformer`: `LayerDefinition.apply(t)`
		 * calls `t` with the mesh it wraps. Following it is how a donkey gets its chest, which is added
		 * in a `modifyMesh` the model only ever reaches through one of these.
		 */
		const lambda = taken.find(value => value.kind === 'lambda');
		if (lambda?.kind === 'lambda' && receiver?.kind === 'object' && taken.length === 1) {
			const applied = this.inline(lambda.owner, lambda.name, lambda.descriptor, null, [receiver]);
			this.push(returns === 'V' ? null : applied ?? receiver);
			return;
		}

		/*
		 * getChild(name): reaching back into a mesh already built to hang something off one of its parts.
		 * The witch's hat goes on the villager head she inherits, the bogged's mushrooms on a skeleton
		 * body. Created when absent, so those parts are at least grouped and named when the mesh they
		 * belong to came from somewhere this interpreter could not follow.
		 */
		if (args.length === 1 && args[0] === 'Ljava/lang/String;' && returns.startsWith('L') && target) {
			const name_ = taken[0].kind === 'string' ? taken[0].value : '';
			const found = target.children.find(child => child.name === name_);
			if (found) {
				this.push({ kind: 'object', handle: found });
			} else {
				const child = this.handle();
				child.name = name_ || `part${child.id}`;
				target.children.push(child);
				this.push({ kind: 'object', handle: child });
			}
			return;
		}

		// addChild(part) — the pre-1.17 shape, where the child was built separately
		if (args.length === 1 && args[0].startsWith('L') && target && taken[0].kind === 'object'
			&& (taken[0].handle.cubes.length > 0 || taken[0].handle.children.length > 0)) {
			target.children.push(taken[0].handle);
			this.push(returns === 'V' ? null : receiver);
			return;
		}

		/*
		 * LayerDefinition.create(mesh, width, height) — a mesh wrapped up with the sheet it is drawn on.
		 * Both halves matter: the wrapper has to pass the mesh through so an inlined `createBodyLayer()`
		 * returns geometry rather than an opaque value, and those two ints are the only place a 1.17+
		 * model states its texture size.
		 */
		const objects = taken.filter(value => value.kind === 'object');
		if (!target && objects.length === 1 && taken.length - objects.length === args.length - 1
			&& args.length >= 2 && args.slice(1).every(arg => NUMERIC.has(arg))) {
			if (args.length === 3) {
				this.shared.textureSize = [numbers[1], numbers[2]];
			}
			this.push(objects[0]);
			return;
		}

		// mirror(boolean) / setTextureSize(int, int) and anything else fluent
		if (args.length === 1 && args[0] === 'Z' && target) {
			target.pendingMirror = this.number(taken[0]) === 1;
			this.push(returns === 'V' ? null : receiver);
			return;
		}

		/*
		 * `mirror()`, which is a no-arg call on a builder that hands the same builder back.
		 *
		 * Told apart from `getRoot()` and `create()` by exactly that: a *self*-returning instance call is
		 * a fluent modifier of the thing it was called on, while `getRoot()` returns a different type and
		 * `create()` is static. Swallowing it cost the mirrored half of every box built that way — a
		 * guardian's two side plates share one texture offset, and the second one needs the flip to take
		 * its picture from the same place. Without it, one side of the guardian sampled blank sheet.
		 */
		if (args.length === 0 && target && returns === `L${owner};`) {
			target.pendingMirror = true;
			this.push(receiver);
			return;
		}

		// getRoot() / create() — no arguments, returns the thing to build on
		if (args.length === 0 && returns.startsWith('L')) {
			if (target) {
				// A mesh's root: reuse one handle per receiver so repeated getRoot() agrees
				target.isRoot = true;
				this.push(receiver);
				return;
			}
			// Unless it is this model's own factory, in which case it returns a piece of this model
			const built = this.inline(owner, name, descriptor, null, taken);
			this.push(built ?? { kind: 'object', handle: this.handle() });
			return;
		}

		const inlined = this.inline(owner, name, descriptor, receiver, taken);
		this.push(returns === 'V' ? null : inlined ?? { kind: 'unknown' });
	}

	private push(value: Value | null): void {
		if (value) {
			this.stack.push(value);
		}
	}

	/** Runs one method's code. Returns false when it hit something it will not guess at. */
	run(code: Uint8Array, constants: ClassFile): boolean {
		let at = 0;
		while (at < code.length) {
			if (this.shared.steps-- <= 0) {
				this.note('ran past the step budget, so the shape is only as far as it got');
				return false;
			}
			const op = code[at++];
			switch (true) {
				// aconst_null
				case op === 0x01: {
					this.push({ kind: 'unknown' });
					break;
				}
				// iconst_m1 … iconst_5
				case op >= 0x02 && op <= 0x08: {
					this.push({ kind: 'number', value: op - 0x03 });
					break;
				}
				// lconst_0, lconst_1
				case LONG_OR_DOUBLE_CONSTANT.has(op): {
					this.push({ kind: 'number', value: op === 0x0A || op === 0x0F ? 1 : 0 });
					break;
				}
				// fconst_0, fconst_1, fconst_2
				case op >= 0x0B && op <= 0x0D: {
					this.push({ kind: 'number', value: op - 0x0B });
					break;
				}
				case op === 0x10: {
					// bipush, signed
					this.push({ kind: 'number', value: (code[at++] << 24) >> 24 });
					break;
				}
				case op === 0x11: {
					// sipush, signed
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
					const value = constants.literal(index);
					if (typeof value === 'string') {
						this.push({ kind: 'string', value });
					} else if (typeof value === 'number') {
						this.push({ kind: 'number', value });
					} else if (typeof value === 'bigint') {
						this.push({ kind: 'number', value: Number(value) });
					} else {
						this.push({ kind: 'unknown' });
					}
					break;
				}
				// iload/lload/fload/dload/aload with an index byte
				case op >= 0x15 && op <= 0x19: {
					this.push(this.locals.get(code[at++]) ?? { kind: 'unknown' });
					break;
				}
				// the _0.._3 forms of the five loads
				case op >= 0x1A && op <= 0x2D: {
					this.push(this.locals.get((op - 0x1A) % 4) ?? { kind: 'unknown' });
					break;
				}
				// istore/lstore/fstore/dstore/astore with an index byte
				case op >= 0x36 && op <= 0x3A: {
					this.locals.set(code[at++], this.pop());
					break;
				}
				// the _0.._3 forms of the five stores
				case op >= 0x3B && op <= 0x4E: {
					this.locals.set((op - 0x3B) % 4, this.pop());
					break;
				}
				case ARRAY_LOADS.has(op): {
					// aaload / iaload / faload: the element the index names, which for a loop is the counter
					const index = this.pop();
					const array = this.pop();
					const at = index.kind === 'number' ? index.value : 0;
					this.push(array.kind === 'array' ? array.items[at] ?? { kind: 'unknown' } : { kind: 'unknown' });
					break;
				}
				// shifts and bitwise ops, which appear in an index calculation rather than in geometry
				case op >= 0x78 && op <= 0x83: {
					this.pop();
					this.pop();
					this.push({ kind: 'number', value: 0 });
					break;
				}
				case op === 0xC1: {
					// instanceof: a variant check, and nothing downstream reads the answer
					at += 2;
					this.pop();
					this.push({ kind: 'number', value: 0 });
					break;
				}
				case op === 0xBF: {
					/*
					 * athrow. The builder is on a path that raises — a guard clause on an argument the game
					 * never passes — so what has been built up to here is the model, and stopping is right.
					 */
					return true;
				}
				case op === 0xBE: {
					/*
					 * arraylength, truthfully. It used to answer zero, which was harmless while conditionals
					 * were guessed and fatal once they were decided: `for (i = 0; i < parts.length; i++)`
					 * became a loop that never runs, and an endermite lost every segment it has.
					 */
					const array = this.pop();
					this.push(array.kind === 'array' ? { kind: 'number', value: array.items.length } : { kind: 'unknown' });
					break;
				}
				case ARRAY_STORES.has(op): {
					// value, index, array — all eight, since a silverfish builds its segments from one
					const value = this.pop();
					const index = this.pop();
					const array = this.pop();
					if (array.kind === 'array') {
						// At its index rather than appended: a table read back by index has to agree with itself
						array.items[index.kind === 'number' ? index.value : array.items.length] = value;
					}
					break;
				}
				case op === 0x57: {
					this.pop();
					break;
				}
				case op === 0x58: {
					this.pop();
					this.pop();
					break;
				}
				case op === 0x59: {
					const top = this.pop();
					this.push(top);
					this.push(top);
					break;
				}
				case op === 0x5A: {
					// dup_x1
					const top = this.pop();
					const under = this.pop();
					this.push(top);
					this.push(under);
					this.push(top);
					break;
				}
				// fadd, fsub, fmul, fdiv and their int/double siblings
				case op >= 0x60 && op <= 0x6F: {
					const right = this.number(this.pop());
					const left = this.number(this.pop());
					// The block of sixteen is add, sub, mul, div in fours: int, long, float, double
					const operate = [
						(): number => left + right,
						(): number => left - right,
						(): number => left * right,
						(): number => left / right,
					][Math.floor((op - 0x60) / 4)];
					this.push({ kind: 'number', value: operate() });
					break;
				}
				// irem and siblings, which a builder uses to place a repeated part around a ring
				case op >= 0x70 && op <= 0x73: {
					const right = this.number(this.pop());
					const left = this.number(this.pop());
					this.push({ kind: 'number', value: right === 0 ? 0 : left % right });
					break;
				}
				// fneg and siblings
				case op >= 0x74 && op <= 0x77: {
					this.push({ kind: 'number', value: -this.number(this.pop()) });
					break;
				}
				// numeric conversions: i2f, f2i, i2d, d2f …
				case op >= 0x85 && op <= 0x93: {
					break;
				}
				case op === 0x84: {
					// iinc: the loop counter, without which a followed loop would never end
					const slot = code[at];
					const step = (code[at + 1] << 24) >> 24;
					at += 2;
					this.locals.set(slot, { kind: 'number', value: this.number(this.locals.get(slot) ?? { kind: 'unknown' }) + step });
					break;
				}
				case RETURNS.has(op): {
					// areturn and friends leave the value the caller inlined this frame for
					if (op !== 0xB1) {
						this.returned = this.pop();
					}
					return true;
				}
				case op === 0xB2: {
					/*
					 * getstatic. An enum constant or a shared `CubeDeformation` is opaque and stays that way,
					 * but a static *table* is not: running the owner's `<clinit>` once fills it, which is the
					 * only way a `static final int[][]` of segment sizes can be read back.
					 */
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					const reference = constants.reference(index);
					const key = reference ? `${reference.owner}.${reference.name}` : '';
					if (reference && !this.shared.statics.has(key)) {
						this.initialise(reference.owner);
					}
					this.push(this.shared.statics.get(key) ?? { kind: 'unknown' });
					break;
				}
				case op === 0xB3: {
					// putstatic: what a `<clinit>` leaves behind for the builder to read
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					const value = this.pop();
					const reference = constants.reference(index);
					if (reference) {
						this.shared.statics.set(`${reference.owner}.${reference.name}`, value);
					}
					break;
				}
				case op === 0xB4: {
					// getfield
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					this.pop();
					const reference = constants.reference(index);
					this.push(this.shared.fields.get(reference?.name ?? '') ?? { kind: 'unknown' });
					break;
				}
				case op === 0xB5: {
					// putfield
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					const value = this.pop();
					this.pop();
					const reference = constants.reference(index);
					if (reference) {
						/*
						 * A subclass assigning a field its superclass already filled is an override, so the
						 * part that was there is gone: `CowModel` replaces the head and body it inherits and
						 * keeps the legs. Without this the model has both heads.
						 */
						const previous = this.shared.fields.get(reference.name);
						if (previous?.kind === 'object' && value.kind === 'object' && previous.handle !== value.handle) {
							previous.handle.consumed = true;
						}
						this.shared.fields.set(reference.name, value);
						// A field holding a part is how the pre-1.17 shape names it
						if (value.kind === 'object' && !value.handle.name) {
							value.handle.name = reference.name;
						}
						if (TEXTURE_WIDTH_FIELDS.has(reference.name)) {
							this.shared.textureSize[0] = this.number(value);
						} else if (TEXTURE_HEIGHT_FIELDS.has(reference.name)) {
							this.shared.textureSize[1] = this.number(value);
						}
					}
					break;
				}
				case INVOKES.has(op): {
					const index = (code[at] << 8) | code[at + 1];
					at += 2;
					if (op === 0xB9) {
						// interface calls carry two more bytes
						at += 2;
					}
					const reference = constants.reference(index);
					if (!reference) {
						break;
					}
					if (op === 0xB7 && reference.name === '<init>') {
						// A constructor: consume its arguments and leave the object that `dup` kept
						const { args } = parseDescriptor(reference.descriptor);
						const taken: Value[] = [];
						for (let count = 0; count < args.length; count++) {
							taken.unshift(this.pop());
						}
						const objectRef = this.pop();
						/*
						 * A single float into a fresh object is a `CubeDeformation`, which is how a 1.17+ model
						 * states how far a box grows. Three floats is the per-axis form; the largest is used,
						 * since a `Cube` carries one number and the point of it is to clear the layer beneath.
						 */
						if (objectRef.kind === 'object' && args.length > 0 && args.length <= 3
							&& args.every(arg => arg === 'F')) {
							objectRef.handle.deformation = Math.max(...taken.map(value => this.number(value)));
						}
						/*
						 * `new ModelRenderer(this, 18, 4)` is where a pre-1.17 part gets its texture offset,
						 * and the only place: that era has no `texOffs` call to read it from, so without this
						 * every box of every model before 1.17 is addressed at the top left of the sheet.
						 */
						if (objectRef.kind === 'object' && args.length >= 2
							&& args.at(-1) === 'I' && args.at(-2) === 'I') {
							objectRef.handle.pendingUv = [
								this.number(taken[args.length - 2]),
								this.number(taken[args.length - 1]),
							];
							objectRef.handle.uvFromConstructor = true;
						}
						// `super(12, 0)` is where a pre-1.17 model's inherited parts come from
						this.inline(reference.owner, reference.name, reference.descriptor, objectRef, taken);
						break;
					}
					this.call(reference.owner, reference.name, reference.descriptor, op !== 0xB8);
					break;
				}
				case op === 0xBB: {
					// new
					at += 2;
					this.push({ kind: 'object', handle: this.handle() });
					break;
				}
				// newarray / anewarray: sized up front, so `arraylength` can answer before anything is stored
				case op === 0xBC || op === 0xBD: {
					at += op === 0xBC ? 1 : 2;
					const length = this.pop();
					const size = length.kind === 'number' ? Math.min(Math.max(length.value, 0), MAX_ARRAY) : 0;
					this.push({ kind: 'array',
						items: Array.from({ length: size }, () => {
							return { kind: 'unknown' as const };
						}) });
					break;
				}
				case op === 0xC0: {
					// checkcast
					at += 2;
					break;
				}
				case op === 0xBA: {
					/*
					 * invokedynamic: a lambda. Its arguments are whatever it captured, and the value it
					 * leaves is the function itself — named, so that whatever is handed it can be followed
					 * into. A model reaches its `MeshTransformer` this way and no other.
					 */
					const index = (code[at] << 8) | code[at + 1];
					at += 4;
					const reference = constants.reference(index);
					const { args, returns } = reference ? parseDescriptor(reference.descriptor) : { args: [], returns: 'V' };
					for (let count = 0; count < args.length; count++) {
						this.pop();
					}
					const target = constants.lambdaTarget(index);
					this.push(returns === 'V'
						? null
						: (target ? { kind: 'lambda', ...target } : { kind: 'unknown' }));
					break;
				}
				/*
				 * Conditionals. A model builder's branches are all on a constructor argument — a
				 * `CubeDeformation`, a "is this the baby variant" flag — so both arms build a real model and
				 * the fall-through is one of them. Taken rather than refused, and recorded, because the
				 * alternative is losing the model outright.
				 */
				case op >= 0x99 && op <= 0xA6: {
					/*
					 * A conditional whose operands are both known is *decided*, which is what lets a counted
					 * loop end: `for (int i = 0; i < 8; i++)` is a comparison against a constant, and until
					 * this was evaluated the loop could only be refused. Deciding it also stops a model
					 * emitting both arms of a branch it could have known the answer to.
					 *
					 * One whose operands are not known is still taken and noted, as before: a builder's
					 * branches turn on constructor arguments, and both arms build a real shape.
					 */
					const twoOperands = op >= 0x9F;
					const right = this.pop();
					const left = twoOperands ? this.pop() : { kind: 'number', value: 0 } as Value;
					const offset = (((code[at] << 8) | code[at + 1]) << 16) >> 16;
					at += 2;
					const decided = left.kind === 'number' && right.kind === 'number'
						// if_acmp* compares references, which are never numbers worth deciding on
						&& op <= 0xA4
						? compare(op, twoOperands ? left.value : right.value, twoOperands ? right.value : 0)
						: null;
					if (decided === null) {
						this.shared.branched = true;
						break;
					}
					if (decided) {
						at += offset - 3;
					}
					break;
				}
				case op === 0xC6 || op === 0xC7: {
					// ifnull / ifnonnull: a null check around an optional layer
					at += 2;
					this.pop();
					this.shared.branched = true;
					break;
				}
				case op === 0xA7: {
					/*
					 * goto. Forward is the tail of an if/else; backward is a loop, and now that the conditional
					 * at its head is decided rather than guessed, following it is what builds the shape: a
					 * ghast's nine tentacles, a magma cube's eight segments and an endermite's four are all
					 * counted loops, and refusing them left the ghast bald and the magma cube a flat slab.
					 *
					 * A loop whose head this *cannot* decide would spin, because an undecided conditional
					 * falls through every time round. So each backward jump is counted, and one that goes
					 * round more times than any real model does is abandoned where it stands — with its own
					 * geometry kept, since a partial shape beats none.
					 */
					const offset = (((code[at] << 8) | code[at + 1]) << 16) >> 16;
					at += 2;
					if (offset > 0) {
						at += offset - 3;
						break;
					}
					const site = at - 3;
					const round = (this.loops.get(site) ?? 0) + 1;
					this.loops.set(site, round);
					if (round > MAX_ITERATIONS) {
						this.note(`a loop at ${site} went round more than ${MAX_ITERATIONS} times, so the shape is only as far as it got`);
						break;
					}
					at += offset - 3;
					break;
				}
				// fcmp/dcmp/lcmp: push a comparison result nothing downstream reads
				case op >= 0x94 && op <= 0x98: {
					this.pop();
					this.pop();
					this.push({ kind: 'number', value: 0 });
					break;
				}
				default: {
					this.shared.notes.push(`unsupported opcode 0x${op.toString(16)} at ${at - 1}`);
					return false;
				}
			}
		}
		return true;
	}
}

/** Turns a handle tree into the exported shape. */
function toPart(handle: Handle): Part {
	return {
		name: handle.name ?? `part${handle.id}`,
		pivot: handle.pivot ?? [0, 0, 0],
		rotation: handle.rotation ?? [0, 0, 0],
		cubes: handle.cubes,
		children: handle.children.map(child => toPart(child)),
	};
}

/**
 * A method that builds the *armour worn on* a model rather than the model itself.
 *
 * The 26 line moved the armour meshes onto the models that wear them, so `HumanoidModel` now offers
 * `createBaseArmorMesh` and `createBabyArmorMesh` beside its own `createMesh`. A baby's armour has
 * more boxes than the humanoid does, so the fullest-mesh rule below picked it, and every player,
 * zombie and armour stand in the pack came out as a set of leggings: a `waist` and an `inner_body`
 * at knee height where the mob should have been.
 *
 * Matched by name, which is exact on a jar Mojang no longer obfuscates and harmless on one they did,
 * where no method is named anything at all.
 */
const ARMOUR_MESH = /armou?r/i;

/**
 * Extracts whatever geometry a class's methods build.
 *
 * Every method is tried, because where the model is built differs by era: 1.17+ vanilla uses a static
 * factory, older vanilla and most mods use the constructor. The one that built the fullest *mesh* is
 * the model, and the methods that only add to a mesh handed to them are merged into it:
 * `QuadrupedModel` puts its head and body in `createBodyMesh` and its four legs in `createLegs`, so
 * picking a single winner silently drops whichever it did not pick.
 *
 * Only those helpers merge, never two methods that each built their own mesh. Those are variants of the
 * same model, a boat and a chest boat, and folding them together puts a chest on every boat.
 */
/** What a call may be followed into, and whether this class is the sort that makes such calls. */
export interface Following {
	/** The class a call names, or null for the builder API and everything else off limits. */
	resolve: (internalName: string) => ClassFile | null;
	/**
	 * Whether the class being extracted is model code. A renderer is not: it constructs the models it
	 * draws, so following those calls makes it look like it holds their geometry, and a pufferfish
	 * renderer that builds all three sizes comes out as one model with three sets of spines.
	 *
	 * Defaults to true, which is right when the caller has no way to tell the two apart.
	 */
	isModelCode?: boolean;
	/**
	 * Which of the class's methods may build the model. Defaults to everything but the armour meshes,
	 * which build the armour *worn on* this model rather than the model — see `ARMOUR_MESH`.
	 *
	 * `extractArmourMesh` passes the opposite, since that is exactly what it is after.
	 */
	methods?: (name: string) => boolean;
}

/** The baby form of an armour mesh, which is a scaled duplicate of the one worn by an adult. */
const BABY_MESH = /baby/i;

/**
 * The armour a humanoid wears, as its own mesh. Empty where the class builds none.
 *
 * The baby form is skipped rather than competing: it has more boxes than the adult's — a separate
 * head and body where the adult reuses the humanoid's — so the fullest-mesh rule would always pick
 * it, and every suit of armour in the world would come out child-sized.
 */
export function extractArmourMesh(bytes: Uint8Array, following: Following): ExtractedModel {
	return extractModel(bytes, {
		...following,
		methods: name => ARMOUR_MESH.test(name) && !BABY_MESH.test(name),
	});
}

export function extractModel(bytes: Uint8Array, following?: Following): ExtractedModel {
	const classFile = parseClassFile(bytes);
	const notes: string[] = [];
	const candidates: Array<{ model: ExtractedModel; ownMesh: boolean; cubes: number; }> = [];
	// Its own methods are always followable; another class's only from model code
	const outward = following?.isModelCode ?? true;
	const wanted = following?.methods ?? ((name: string): boolean => !ARMOUR_MESH.test(name));
	const own = (internalName: string): ClassFile | null => {
		if (internalName === classFile.thisClass) {
			return classFile;
		}
		return outward ? following?.resolve(internalName) ?? null : null;
	};
	for (const method of classFile.methods) {
		if (!method.code || !wanted(method.name)) {
			continue;
		}
		const shared = newShared(own);
		let ok: boolean;
		try {
			ok = new Interpreter(shared).run(method.code, classFile);
		} catch (err) {
			notes.push(`${method.name}: ${(err as Error).message}`);
			continue;
		}
		if (!ok) {
			notes.push(`${method.name}: ${shared.notes.join('; ')}`);
		}
		// Roots are the handles nothing else adopted
		const adopted = new Set(shared.handles.flatMap(handle => handle.children));
		const roots = shared.handles.filter(handle => !adopted.has(handle)
			&& !handle.consumed
			&& (handle.cubes.length > 0 || handle.children.length > 0));
		if (roots.length === 0) {
			continue;
		}
		/*
		 * A part added to a mesh this method was handed — `PigModel` replaces the head on the one
		 * `QuadrupedModel.createBodyMesh` returned — has a parent the interpreter never saw. The box and
		 * its pose are still right; what is lost is what it hangs from, so it sits at the model origin.
		 *
		 * Said out loud, because a consumer cannot tell from the geometry alone. Several roots on their
		 * own is not this: before 1.17 a model's parts were fields, and a flat list is what it *is*.
		 */
		const orphans = roots.filter(root => root.orphaned).length;
		const model: ExtractedModel = {
			textureSize: shared.textureSize,
			parts: roots.map(root => toPart(root)),
			notes: [
				...shared.notes,
				...(orphans > 0
					? [`${orphans} disconnected roots: built for a parent in another class, so each sits at the model origin`]
					: []),
				...(shared.branched ? ['a conditional was taken; the shape is one of the variants this builder makes'] : []),
			],
		};
		candidates.push({ model, ownMesh: buildsOwnMesh(model), cubes: cubesOf(model) });
	}

	const byCubes = candidates.filter(candidate => candidate.cubes > 0)
		.toSorted((left, right) => right.cubes - left.cubes);
	// A method that built its own mesh is the model; one that only added to a mesh is a helper of it
	const base = byCubes.find(candidate => candidate.ownMesh) ?? byCubes[0];
	if (!base) {
		return { textureSize: [64, 32], parts: [], notes };
	}
	let model = base.model;
	for (const helper of byCubes) {
		if (helper !== base && !helper.ownMesh) {
			model = mergeModels(model, helper.model);
		}
	}
	return model;
}
