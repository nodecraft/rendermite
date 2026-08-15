/**
 * Dev-time part-table extractor. Runs `javap -c` over a mod's entity-model class
 * and reads the CubeListBuilder chain out of the bytecode listing.
 *
 * Calls are matched on owner class + descriptor, never on method name: Minecraft
 * class names survive both official (NeoForge 1.21+) and SRG (Forge 1.20.1)
 * mappings, method names do not. The one descriptor collision is
 * PartPose.offset vs PartPose.rotation, both (FFF)LPartPose; — resolved by the
 * SRG_ROTATION list below, cross-referenced between Mekanism's officially-mapped
 * NeoForge jar and its SRG-mapped Forge jar for the same class.
 *
 * Values are read as constants off a small operand buffer: these chains are
 * linear and constant-only in every mod checked, so no real interpretation is
 * needed. Anything non-constant simply yields no cube, which shows up as a
 * missing part rather than a wrong one.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** SRG ids known to be PartPose.rotation (NOT offset). */
const SRG_ROTATION = new Set(['m_171430_', 'rotation']);

const WORK = path.join(import.meta.dirname, '..', '..', '.work', 'mod-models', 'classes');

export interface Cube {
	texOffs: [number, number];
	box: [number, number, number, number, number, number];
	inflate?: number;
	mirror?: boolean;
}

export interface Part {
	name: string;
	parent: string | null;
	cubes: Cube[];
	offset?: [number, number, number];
	rot?: [number, number, number];
}

export interface PartTable {
	class: string;
	textureWidth: number | null;
	textureHeight: number | null;
	parts: Part[];
}

function unpack(jar: string, suffix: string): string[] {
	const list = execFileSync('unzip', ['-Z1', jar], { encoding: 'utf8', maxBuffer: 1 << 28 })
		.split('\n')
		.filter(name => name.endsWith('.class') && name.includes(suffix));
	if (list.length === 0) {
		throw new Error(`no class matching ${suffix} in ${jar}`);
	}
	fs.mkdirSync(WORK, { recursive: true });
	execFileSync('unzip', ['-o', '-q', jar, ...list, '-d', WORK], { maxBuffer: 1 << 28 });
	return list;
}

/** javap prints one instruction per line; only constant pushes and invokes matter. */
function parse(listing: string, className: string): PartTable {
	const table: PartTable = { class: className, textureWidth: null, textureHeight: null, parts: [] };
	const nums: number[] = [];
	const strings: string[] = [];
	const vars = new Map<string, string>();

	let cubes: Cube[] = [];
	let texOffs: [number, number] = [0, 0];
	let mirror = false;
	let inflate: number | undefined;
	let pose: { offset?: [number, number, number]; rot?: [number, number, number]; } = {};
	let lastLoadedVar: string | null = null;

	const takeNums = (count: number): number[] => nums.splice(Math.max(0, nums.length - count), count);

	for (const rawLine of listing.split('\n')) {
		const line = rawLine.trim();

		// --- constant pushes ---
		let match = /^\d+: (?:iconst_(m?\d)|bipush\s+(-?\d+)|sipush\s+(-?\d+))$/.exec(line);
		if (match) {
			const raw = match[1] ?? match[2] ?? match[3];
			nums.push(Number(raw.startsWith('m') ? -Number(raw.slice(1)) : raw));
			continue;
		}
		match = /^\d+: fconst_(\d)$/.exec(line);
		if (match) {
			nums.push(Number(match[1]));
			continue;
		}
		match = /^\d+: ldc(?:_w|2_w)?\s+#\d+\s+\/\/ (?:float|int|double|long)\s+([-+\d.E]+)f?d?$/.exec(line);
		if (match) {
			nums.push(Number(match[1]));
			continue;
		}
		match = /^\d+: ldc(?:_w)?\s+#\d+\s+\/\/ String (.*)$/.exec(line);
		if (match) {
			strings.push(match[1]);
			continue;
		}
		match = /^\d+: (?:aload_(\d)|aload\s+(\d+))$/.exec(line);
		if (match) {
			lastLoadedVar = match[1] ?? match[2];
			continue;
		}
		match = /^\d+: (?:astore_(\d)|astore\s+(\d+))$/.exec(line);
		const lastPart = table.parts.at(-1);
		if (match && lastPart) {
			vars.set(match[1] ?? match[2], lastPart.name);
			continue;
		}
		// PartPose.ZERO
		if (/getstatic.*\/PartPose\.[\w$]+:L.*PartPose;$/.test(line)) {
			pose = {};
			continue;
		}
		// Array length and element indices are not geometry values — Mekanism
		// passes its parts as a varargs array, so these fire once per part.
		if (/^\d+: (?:aastore|anewarray)\b/.test(line)) {
			takeNums(1);
			continue;
		}

		// --- invocations, matched by owner + descriptor ---
		// javap omits the owner for same-class calls (Mekanism's own
		// createLayerDefinition helper), so the owner group is optional.
		const invoke = /^\d+: invoke(static|virtual|special|interface)\s+#[\d,\s]+\/\/ (?:Interface)?Method (?:([\w/$]+)\.)?"?([\w$<>]+)"?:\(([^)]*)\)(.*)$/.exec(line);
		if (!invoke) {
			continue;
		}
		const [, kind, owner, method, argDesc, ret] = invoke;
		const ownerName = owner ? owner.split('/').pop() ?? owner : '';

		if (ownerName === 'CubeListBuilder' && ret.endsWith('CubeListBuilder;')) {
			if (kind === 'static' && argDesc === '') {
				// create(): a fresh cube list, so the previous part is finished.
				cubes = [];
				texOffs = [0, 0];
				mirror = false;
				continue;
			}
			if (argDesc === 'II') {
				const [offsetU, offsetV] = takeNums(2);
				texOffs = [offsetU, offsetV];
				continue;
			}
			if (argDesc === '' || argDesc === 'Z') {
				if (argDesc === 'Z') {
					takeNums(1);
				}
				mirror = true;
				continue;
			}
			if (argDesc.startsWith('FFFFFF')) {
				const box = takeNums(6) as Cube['box'];
				cubes.push({
					texOffs: [...texOffs],
					box,
					...(inflate !== undefined && { inflate }),
					...(mirror && { mirror: true }),
				});
				inflate = undefined;
				continue;
			}
		}
		if (ownerName === 'CubeDeformation' && method === '<init>' && argDesc === 'F') {
			[inflate] = takeNums(1);
			continue;
		}
		if (ownerName === 'PartPose' && ret.endsWith('PartPose;')) {
			if (argDesc === 'FFF') {
				const values = takeNums(3) as [number, number, number];
				if (SRG_ROTATION.has(method)) {
					pose = { rot: values };
				} else {
					pose = { offset: values };
				}
				continue;
			}
			if (argDesc === 'FFFFFF') {
				const values = takeNums(6);
				pose = {
					offset: values.slice(0, 3) as [number, number, number],
					rot: values.slice(3) as [number, number, number],
				};
				continue;
			}
		}
		// addOrReplaceChild(String, CubeListBuilder, PartPose) — vanilla API — or
		// Mekanism's ModelPartData(String, CubeListBuilder, [PartPose,] children).
		const isChild = ownerName === 'PartDefinition' && /^Ljava\/lang\/String;L.*CubeListBuilder;L.*PartPose;$/.test(argDesc);
		const isMekPart = ownerName === 'ModelPartData' && method === '<init>';
		if (isChild || isMekPart) {
			const name = strings.pop() ?? `part${table.parts.length}`;
			table.parts.push({
				name,
				parent: isChild ? vars.get(lastLoadedVar ?? '') ?? null : null,
				cubes,
				...pose,
			});
			cubes = [];
			pose = {};
			continue;
		}
		if (ownerName === 'LayerDefinition' && argDesc.endsWith('MeshDefinition;II')) {
			const [width, height] = takeNums(2);
			table.textureWidth = width;
			table.textureHeight = height;
			continue;
		}
		// Mekanism: createLayerDefinition(int texW, int texH, ModelPartData...)
		if (method.includes('createLayerDefinition') && /^II[[L]/.test(argDesc)) {
			const [width, height] = takeNums(2);
			table.textureWidth = width;
			table.textureHeight = height;
		}
	}
	return table;
}

export function extractPartTables(jar: string, classSuffix: string): PartTable[] {
	const tables: PartTable[] = [];
	for (const entry of unpack(jar, classSuffix)) {
		const listing = execFileSync('javap', ['-p', '-c', path.join(WORK, entry)], { encoding: 'utf8', maxBuffer: 1 << 28 });
		const table = parse(listing, entry);
		if (table.parts.length > 0) {
			tables.push(table);
		}
	}
	return tables;
}
