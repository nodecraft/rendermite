/**
 * A minimal JVM class-file reader: constant pool, methods, and each method's `Code`.
 *
 * Written rather than taken from npm because the whole of what is needed is the constant pool and one
 * attribute — every published class-file library is an order of magnitude more than that, and this
 * runs in a package whose entire dependency list is three entries.
 *
 * It exists because entity models are Java code at every version (see docs/entity-geometry.md), so
 * the only automatic way to recover their geometry is to read the code.
 *
 * Spec: https://docs.oracle.com/javase/specs/jvms/se21/html/jvms-4.html
 */

export type ConstantTag =
	| 'utf8' | 'integer' | 'float' | 'long' | 'double' | 'class' | 'string'
	| 'fieldref' | 'methodref' | 'interfaceMethodref' | 'nameAndType'
	| 'methodHandle' | 'methodType' | 'dynamic' | 'invokeDynamic' | 'module' | 'package';

export interface Constant {
	tag: ConstantTag;
	/** Utf8 text, or the numeric value of an integer/float/long/double. */
	value?: string | number | bigint;
	/** Indexes into the pool, by whatever the tag needs. */
	nameIndex?: number;
	classIndex?: number;
	nameAndTypeIndex?: number;
	descriptorIndex?: number;
	stringIndex?: number;
}

export interface MethodInfo {
	name: string;
	descriptor: string;
	accessFlags: number;
	/** Raw bytecode of the `Code` attribute, absent on an abstract or native method. */
	code?: Uint8Array;
}

export interface ClassFile {
	thisClass: string;
	superClass: string | null;
	constants: Array<Constant | null>;
	methods: MethodInfo[];
	/** A pool entry as text, for a `utf8` or anything that resolves to one. */
	utf8: (index: number) => string;
	/** `owner.name:descriptor` for a field or method reference. */
	reference: (index: number) => { owner: string; name: string; descriptor: string; } | null;
	/** The value an `ldc` of this index pushes: a number for numeric constants, a string for `string`. */
	literal: (index: number) => string | number | bigint | null;
}

class Reader {
	private at = 0;
	private readonly bytes: Uint8Array;
	private readonly view: DataView;

	constructor(bytes: Uint8Array) {
		this.bytes = bytes;
		this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}

	u1(): number {
		return this.view.getUint8(this.at++);
	}

	u2(): number {
		const value = this.view.getUint16(this.at);
		this.at += 2;
		return value;
	}

	u4(): number {
		const value = this.view.getUint32(this.at);
		this.at += 4;
		return value;
	}

	i4(): number {
		const value = this.view.getInt32(this.at);
		this.at += 4;
		return value;
	}

	f4(): number {
		const value = this.view.getFloat32(this.at);
		this.at += 4;
		return value;
	}

	f8(): number {
		const value = this.view.getFloat64(this.at);
		this.at += 8;
		return value;
	}

	i8(): bigint {
		const value = this.view.getBigInt64(this.at);
		this.at += 8;
		return value;
	}

	utf8(length: number): string {
		// Modified UTF-8, but every identifier in practice is ASCII; the decoder is close enough
		const text = new TextDecoder('utf-8').decode(this.bytes.subarray(this.at, this.at + length));
		this.at += length;
		return text;
	}

	skip(count: number): void {
		this.at += count;
	}

	take(count: number): Uint8Array {
		const slice = this.bytes.subarray(this.at, this.at + count);
		this.at += count;
		return slice;
	}
}

/** Pool tags, by their spec number. `null` marks the two that take two slots. */
const TAGS: Record<number, ConstantTag> = {
	1: 'utf8',
	3: 'integer',
	4: 'float',
	5: 'long',
	6: 'double',
	7: 'class',
	8: 'string',
	9: 'fieldref',
	10: 'methodref',
	11: 'interfaceMethodref',
	12: 'nameAndType',
	15: 'methodHandle',
	16: 'methodType',
	17: 'dynamic',
	18: 'invokeDynamic',
	19: 'module',
	20: 'package',
};

function readConstantPool(reader: Reader): Array<Constant | null> {
	const count = reader.u2();
	const constants: Array<Constant | null> = [null];
	for (let index = 1; index < count; index++) {
		const raw = reader.u1();
		const tag = TAGS[raw];
		if (!tag) {
			throw new Error(`Unknown constant pool tag ${raw} at ${index}`);
		}
		switch (tag) {
			case 'utf8': {
				constants.push({ tag, value: reader.utf8(reader.u2()) });
				break;
			}
			case 'integer': {
				constants.push({ tag, value: reader.i4() });
				break;
			}
			case 'float': {
				constants.push({ tag, value: reader.f4() });
				break;
			}
			case 'long': {
				constants.push({ tag, value: reader.i8() });
				// A long or double takes two pool slots, and the second is unusable
				constants.push(null);
				index++;
				break;
			}
			case 'double': {
				constants.push({ tag, value: reader.f8() });
				constants.push(null);
				index++;
				break;
			}
			case 'class':
			case 'module':
			case 'package': {
				constants.push({ tag, nameIndex: reader.u2() });
				break;
			}
			case 'string': {
				constants.push({ tag, stringIndex: reader.u2() });
				break;
			}
			case 'fieldref':
			case 'methodref':
			case 'interfaceMethodref': {
				constants.push({ tag, classIndex: reader.u2(), nameAndTypeIndex: reader.u2() });
				break;
			}
			case 'nameAndType': {
				constants.push({ tag, nameIndex: reader.u2(), descriptorIndex: reader.u2() });
				break;
			}
			case 'methodHandle': {
				reader.skip(1);
				constants.push({ tag, nameAndTypeIndex: reader.u2() });
				break;
			}
			case 'methodType': {
				constants.push({ tag, descriptorIndex: reader.u2() });
				break;
			}
			case 'dynamic':
			case 'invokeDynamic': {
				reader.skip(2);
				constants.push({ tag, nameAndTypeIndex: reader.u2() });
				break;
			}
		}
	}
	return constants;
}

/** Skips an attribute table, returning the `Code` bytes if one of them is a Code attribute. */
function readAttributes(reader: Reader, utf8: (index: number) => string): Uint8Array | undefined {
	let code: Uint8Array | undefined;
	const count = reader.u2();
	for (let index = 0; index < count; index++) {
		const name = utf8(reader.u2());
		const length = reader.u4();
		if (name !== 'Code') {
			reader.skip(length);
			continue;
		}
		// max_stack, max_locals, then the code itself
		reader.skip(4);
		code = reader.take(reader.u4());
		// exception_table
		reader.skip(reader.u2() * 8);
		// The Code attribute's own nested attributes (LineNumberTable and friends)
		readAttributes(reader, utf8);
	}
	return code;
}

export function parseClassFile(bytes: Uint8Array): ClassFile {
	const reader = new Reader(bytes);
	if (reader.u4() !== 0xCA_FE_BA_BE) {
		throw new Error('Not a class file: bad magic');
	}
	// minor, major
	reader.skip(4);
	const constants = readConstantPool(reader);

	const utf8 = (index: number): string => {
		const entry = constants[index];
		if (!entry) {
			return '';
		}
		if (entry.tag === 'utf8') {
			return String(entry.value);
		}
		// A class or a string resolves through one more hop
		const next = entry.nameIndex ?? entry.stringIndex ?? entry.descriptorIndex;
		return next === undefined ? '' : utf8(next);
	};

	// access_flags
	reader.skip(2);
	const thisClass = utf8(reader.u2());
	const superIndex = reader.u2();
	const superClass = superIndex === 0 ? null : utf8(superIndex);
	reader.skip(reader.u2() * 2);

	// fields: skipped, but their attributes have to be walked to reach the methods
	const fieldCount = reader.u2();
	for (let index = 0; index < fieldCount; index++) {
		reader.skip(6);
		readAttributes(reader, utf8);
	}
	const methods: MethodInfo[] = [];
	const methodCount = reader.u2();
	for (let index = 0; index < methodCount; index++) {
		const accessFlags = reader.u2();
		const name = utf8(reader.u2());
		const descriptor = utf8(reader.u2());
		const code = readAttributes(reader, utf8);
		methods.push({ name, descriptor, accessFlags, code });
	}

	const reference = (index: number): { owner: string; name: string; descriptor: string; } | null => {
		const entry = constants[index];
		if (!entry || entry.classIndex === undefined || entry.nameAndTypeIndex === undefined) {
			return null;
		}
		const nameAndType = constants[entry.nameAndTypeIndex];
		if (!nameAndType?.nameIndex || !nameAndType.descriptorIndex) {
			return null;
		}
		return {
			owner: utf8(entry.classIndex),
			name: utf8(nameAndType.nameIndex),
			descriptor: utf8(nameAndType.descriptorIndex),
		};
	};

	const literal = (index: number): string | number | bigint | null => {
		const entry = constants[index];
		if (!entry) {
			return null;
		}
		if (entry.tag === 'string') {
			return utf8(index);
		}
		return entry.value ?? null;
	};

	return { thisClass, superClass, constants, methods, utf8, reference, literal };
}
