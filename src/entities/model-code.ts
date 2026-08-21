/**
 * Which classes in a jar count as model code, and their parsed form.
 *
 * The interpreter follows calls into model code and models the builder API abstractly instead, so the
 * line between the two has to be drawn somewhere. It is drawn by name: everything with `model` in its
 * path except the `client.model.geom` package, which is `CubeListBuilder`, `PartDefinition`, `PartPose`
 * and friends. Following `CubeListBuilder.addBox` into its real implementation would interpret a list
 * append and lose the box.
 *
 * The name tested is the *original* one, so an obfuscated jar needs its mappings. Which is fine: they
 * are already loaded to find the model classes at all.
 */

import { parseClassFile } from './classfile.ts';

import type { ClassFile } from './classfile.ts';

export interface ModelCode {
	/** The parsed class, when it is model code a call may be followed into. */
	resolve: (internalName: string) => ClassFile | null;
}

export function isModelCode(name: string): boolean {
	const lower = name.toLowerCase();
	return lower.includes('model') && !lower.includes('geom');
}

/**
 * Reads every model class in a jar, ready to interpret.
 *
 * Read up front because interpretation is synchronous and a call's target is only known once it is
 * reached. Parsing stays lazy: a jar has a few hundred of these and a model only ever calls a handful.
 */
export async function loadModelCode(
	names: Iterable<string>,
	read: (internalName: string) => Promise<Uint8Array | null>,
	originalOf?: (internalName: string) => string,
): Promise<ModelCode> {
	const code = new Map<string, Uint8Array>();
	for (const name of names) {
		if (!isModelCode(originalOf?.(name) ?? name)) {
			continue;
		}
		const bytes = await read(name);
		if (bytes) {
			code.set(name.replaceAll('.', '/'), bytes);
		}
	}
	const parsed = new Map<string, ClassFile | null>();
	return {
		// A mapping states a class with dots and a constant pool with slashes; both arrive here
		resolve: (name) => {
			const internalName = name.replaceAll('.', '/');
			if (!parsed.has(internalName)) {
				const bytes = code.get(internalName);
				let classFile: ClassFile | null;
				try {
					classFile = bytes ? parseClassFile(bytes) : null;
				} catch {
					classFile = null;
				}
				parsed.set(internalName, classFile);
			}
			return parsed.get(internalName) ?? null;
		},
	};
}
