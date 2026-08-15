/**
 * Regenerates assets/mod-tints/mysticalagriculture from the mod's own bytecode:
 *
 *   node scripts/mod-tints/mysticalagriculture.ts <jar>
 *
 * Mystical Agriculture's augments all share one greyscale sprite and are told
 * apart purely by a tint its client code computes, so an untinted render makes
 * every augment look alike. Nothing in the mod's data states those colours —
 * each augment class passes a primary and secondary int up to `Augment.<init>`,
 * and `ModAugments` is what pairs a registry id with the class. Reading both is
 * mechanical, so no colour here is hand-copied. Requires `javap` (any JDK).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const AUGMENT_PACKAGE = 'com/blakebr0/mysticalagriculture/augment';
const REGISTRY_CLASS = 'com/blakebr0/mysticalagriculture/lib/ModAugments.class';

const [jar] = process.argv.slice(2);
if (!jar) {
	throw new Error('usage: mysticalagriculture.ts <mystical-agriculture jar>');
}
const work = path.join(import.meta.dirname, '..', '..', '.work', 'mod-tints', 'ma');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
execFileSync('unzip', ['-o', '-q', jar, `${AUGMENT_PACKAGE}/*.class`, REGISTRY_CLASS, '-d', work], { maxBuffer: 1 << 28 });

const disassemble = (file: string): string => execFileSync('javap', ['-p', '-c', file], { encoding: 'utf8', maxBuffer: 1 << 28 });

/** Each augment class hands its two colours to Augment's constructor. */
const coloursByClass = new Map<string, [number, number]>();
const augmentDirectory = path.join(work, AUGMENT_PACKAGE);
for (const file of fs.readdirSync(augmentDirectory)) {
	if (!file.endsWith('.class') || file.includes('$')) {
		continue;
	}
	const listing = disassemble(path.join(augmentDirectory, file));
	const constructor = listing.split(/\n\s*\n/).find(block => block.includes('Augment."<init>"'));
	if (!constructor) {
		continue;
	}
	const before = constructor.slice(0, constructor.indexOf('Augment."<init>"'));
	const ints = before.matchAll(/ldc(?:_w)?\s+#\d+\s+\/\/ int (-?\d+)/g).map(match => Number(match[1])).toArray();
	const primary = ints.at(-2);
	const secondary = ints.at(-1);
	if (primary !== undefined && secondary !== undefined) {
		coloursByClass.set(file.replace('.class', ''), [primary, secondary]);
	}
}

/** ModAugments constructs each class right before naming its registry id. */
const registry = disassemble(path.join(work, REGISTRY_CLASS)).split('\n');
const entries: Array<{ id: string; colours: [number, number]; }> = [];
let pending: string | null = null;
for (const line of registry) {
	const constructed = /new\s+#\d+\s+\/\/ class com\/blakebr0\/mysticalagriculture\/augment\/(\w+)/.exec(line);
	if (constructed) {
		pending = constructed[1];
		continue;
	}
	const named = /ldc(?:_w)?\s+#\d+\s+\/\/ String ([a-z\d_]+)$/.exec(line.trim());
	const colours = pending && coloursByClass.get(pending);
	if (named && colours) {
		entries.push({ id: named[1], colours });
		pending = null;
	}
}

const out = path.join(import.meta.dirname, '..', '..', 'assets', 'mod-tints', 'mysticalagriculture', 'items');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const { id, colours } of entries) {
	const item = `${id}_augment`;
	fs.writeFileSync(path.join(out, `${item}.json`), `${JSON.stringify({
		model: {
			type: 'minecraft:model',
			model: `mysticalagriculture:item/${item}`,
			// Augment.getPrimaryColor() then getSecondaryColor(), as the mod's own
			// tint source reads them for tint index 0 and 1.
			tints: colours.map((value) => {
				return { type: 'minecraft:constant', value };
			}),
		},
	}, null, '\t')}\n`);
}
console.log(`wrote ${entries.length} augment tints`);
