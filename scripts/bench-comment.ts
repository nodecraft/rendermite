/**
 * Turns one paired `vitest bench --outputJson` report into the pull request comment.
 *
 *   node scripts/bench-comment.ts --report .bench/bench.json --out comment.md
 *
 * The report holds both sides: `bench/sides.ts` registers each workload four
 * times, as `base, head, head2, base2`, adjacent in one process.
 *
 * The hard part is not the formatting, it is not crying wolf. Two things have to
 * agree before anything is called a change:
 *
 * - the confidence intervals of the better pair do not overlap, using tinybench's
 *   own margin of error
 * - *both* orderings clear `FLOOR`, in the same direction. A workload that only
 *   separates when a particular side runs second is measuring the warm JIT it
 *   inherited, not the code
 *
 * Monitoring, not a gate.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
	options: {
		'report': { type: 'string' },
		'out': { type: 'string' },
		'base-label': { type: 'string', default: 'main' },
		'head-label': { type: 'string', default: 'this PR' },
	},
});

if (!values.report) {
	throw new Error('Pass --report <json>.');
}

/**
 * How far apart both orderings must independently put the two sides.
 *
 * Not a guess: benching a commit against itself is the only honest way to find
 * it. On that run the worst pair of orderings to agree in direction was
 * `resources :: discover a namespace` at 7.3% and 4.8%, of identical code, so
 * anything under 10% is a number this harness cannot tell apart from the
 * machine it ran on, and a hosted runner is noisier than the desktop that
 * produced those figures.
 *
 * So this is a screen for changes worth a reviewer's attention, not a
 * guarantee. A real regression under the floor reads as white; the collapsed
 * table carries every number for anyone who wants to look closer, and
 * `node --run bench:against -- --base HEAD` says what today's floor really is.
 */
const FLOOR = 0.1;

/** Identical code on both sides, so its gap is this run's own noise. */
const CALIBRATION = 'reference :: calibration';

/** Must match `GROUP_SEPARATOR` and `CASES` in `bench/sides.ts`. */
const GROUP_SEPARATOR = ' :: ';
const CASE_NAMES = { base: 'base', head: 'head', headRepeat: 'head2', baseRepeat: 'base2' } as const;

/** The fields of tinybench's report this reads; Vitest passes them through untouched. */
interface Benchmark {
	name: string;
	mean: number;
	moe: number;
	rme: number;
	p99: number;
	sampleCount: number;
}

interface VitestBenchReport {
	files: Array<{ filepath: string; groups: Array<{ fullName: string; benchmarks: Benchmark[]; }>; }>;
}

type Verdict = 'faster' | 'slower' | 'same' | 'unpaired';

interface Comparison {
	area: string;
	workload: string;
	base: Benchmark | null;
	head: Benchmark | null;
	/** Positive is faster. Null where the report holds no base case to compare against. */
	delta: number | null;
	verdict: Verdict;
}

const report = JSON.parse(readFileSync(values.report, 'utf8')) as VitestBenchReport;

const comparisons: Comparison[] = [];
for (const file of report.files) {
	for (const group of file.groups) {
		// `fullName` is `<file> > <area> :: <workload>`
		const described = group.fullName.slice(group.fullName.indexOf(' > ') + 3);
		const [area, workload] = described.split(GROUP_SEPARATOR);
		const find = (label: string): Benchmark | null => group.benchmarks.find(entry => entry.name === label) ?? null;
		const first = { base: find(CASE_NAMES.base), head: find(CASE_NAMES.head) };
		const second = { base: find(CASE_NAMES.baseRepeat), head: find(CASE_NAMES.headRepeat) };
		const common = { area: area ?? described, workload: workload ?? '' };

		if (!first.base || !first.head) {
			comparisons.push({ ...common, base: first.base, head: first.head, delta: null, verdict: 'unpaired' });
			continue;
		}
		// The better of each side's runs: a minimum is the least interference-contaminated estimate
		const base = second.base && second.base.mean < first.base.mean ? second.base : first.base;
		const head = second.head && second.head.mean < first.head.mean ? second.head : first.head;
		const delta = (base.mean - head.mean) / base.mean;

		const separated = Math.abs(base.mean - head.mean) > (base.moe + head.moe);
		/*
		 * Every ordering has to clear the floor in the same direction. Where there
		 * is no repeat to check against this is just the one ordering.
		 */
		const orderings = [first, second]
			.filter(pair => pair.base && pair.head)
			.map(pair => ((pair.base as Benchmark).mean - (pair.head as Benchmark).mean) / (pair.base as Benchmark).mean);
		const consistent = orderings.every(each => Math.abs(each) >= FLOOR && Math.sign(each) === Math.sign(delta));
		const real = separated && consistent;
		comparisons.push({ ...common, base, head, delta, verdict: real ? (delta > 0 ? 'faster' : 'slower') : 'same' });
	}
}
comparisons.sort((left, right) => (left.area.localeCompare(right.area) || left.workload.localeCompare(right.workload)));

const name = (entry: Comparison): string => [entry.area, entry.workload].join(GROUP_SEPARATOR);

function time(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms === 0) {
		return '—';
	}
	if (ms < 1) {
		return `${(ms * 1000).toFixed(0)} µs`;
	}
	if (ms < 10) {
		return `${ms.toFixed(3)} ms`;
	}
	return `${ms.toFixed(1)} ms`;
}

/** A ratio for a big move and a percentage for a small one, which is how people read these. */
function magnitude(baseMean: number, headMean: number): string {
	const ratio = baseMean / headMean;
	if (ratio >= 1.5) {
		return `${ratio.toFixed(1)}x faster`;
	}
	if (ratio <= 1 / 1.5) {
		return `${(1 / ratio).toFixed(1)}x slower`;
	}
	const percent = ((baseMean - headMean) / baseMean) * 100;
	return `${Math.abs(percent).toFixed(0)}% ${percent > 0 ? 'faster' : 'slower'}`;
}

const calibration = comparisons.find(entry => name(entry) === CALIBRATION);
// Excluded from the callouts: byte-identical code cannot regress, so whatever it
// reads is the floor everything else is measured against.
const measured = comparisons.filter(entry => name(entry) !== CALIBRATION);
const moved = measured
	.filter(entry => entry.verdict === 'faster' || entry.verdict === 'slower')
	// Biggest move first, so the interesting row is the first one read
	.toSorted((left, right) => Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0));
const faster = moved.filter(entry => entry.verdict === 'faster');
const slower = moved.filter(entry => entry.verdict === 'slower');
const unpaired = measured.filter(entry => entry.verdict === 'unpaired');

const ICON: Record<Verdict, string> = { faster: '🟢', slower: '🔴', same: '⚪', unpaired: '⚠️' };
const paired = measured.length - unpaired.length;

const floorDelta = calibration?.delta ?? null;
const summary = [
	`\`${values['head-label']}\` vs \`${values['base-label']}\``,
	`${paired} paired workloads`,
	floorDelta === null ? 'no calibration in this run' : `harness floor ${Math.abs(floorDelta * 100).toFixed(1)}%`,
].join(' · ');

const lines: string[] = ['#### Benchmarks', '', summary, ''];

if (paired === 0) {
	lines.push(`**Nothing to compare.** No workload had a \`${values['base-label']}\` side; the base tree may have failed to load.`, '');
} else if (moved.length === 0) {
	lines.push('**No significant change.** Every workload is inside this run\'s noise.', '');
} else {
	const parts = [
		faster.length > 0 ? `**${faster.length} faster**` : '',
		slower.length > 0 ? `**${slower.length} slower**` : '',
	].filter(Boolean);
	lines.push(
		`${parts.join(', ')} of ${paired}. Everything else is within this run's noise.`,
		'',
		`| workload | ${values['base-label']} | ${values['head-label']} | change |`,
		'| --- | ---: | ---: | --- |',
		...moved.map(entry => `| \`${name(entry)}\` | ${time(entry.base?.mean)} | ${time(entry.head?.mean)} | ${ICON[entry.verdict]} **${magnitude(entry.base?.mean ?? 0, entry.head?.mean ?? 1)}** |`),
		'',
	);
}

if (unpaired.length > 0) {
	lines.push(
		`${unpaired.length} workload${unpaired.length === 1 ? '' : 's'} had nothing to compare against, so it is new here or absent from \`${values['base-label']}\`: ${unpaired.map(entry => `\`${name(entry)}\``).join(', ')}.`,
		'',
	);
}

lines.push(
	'<details>',
	`<summary>All ${comparisons.length} workloads</summary>`,
	'',
	`Each side ran twice, in opposite order, and the better run of each is quoted. \`±\` is tinybench's margin of error on this PR's. A change counts only where the two intervals stop overlapping *and* both orderings put the sides at least ${(FLOOR * 100).toFixed(0)}% apart in the same direction, so a ⚪ row moved by less than that.`,
	'',
	`| workload | ${values['base-label']} | ${values['head-label']} | ± | p99 | samples | change | |`,
	'| --- | ---: | ---: | ---: | ---: | ---: | --- | --- |',
	...comparisons.map((entry) => {
		const cells = [
			`\`${name(entry)}\``,
			time(entry.base?.mean),
			time(entry.head?.mean),
			entry.head ? `±${entry.head.rme.toFixed(1)}%` : '—',
			time(entry.head?.p99),
			entry.head ? String(entry.head.sampleCount) : '—',
			entry.base && entry.head ? magnitude(entry.base.mean, entry.head.mean) : 'unpaired',
			name(entry) === CALIBRATION ? '📏' : ICON[entry.verdict],
		];
		return `| ${cells.join(' | ')} |`;
	}),
	'',
	'Both sides run in one process as adjacent cases, because two runs drift by more than any real change: the report this replaced compared a run against an artifact from another hosted runner, which moved the whole table at once. `📏 reference :: calibration` is byte-identical code on both sides, so its gap is this run\'s own noise. If it is large, read nothing else here.',
	'',
	'</details>',
);

const markdown = `${lines.join('\n')}\n`;
if (values.out) {
	writeFileSync(values.out, markdown);
	process.stderr.write(`wrote ${values.out}\n`);
} else {
	process.stdout.write(markdown);
}
process.stderr.write(`${faster.length} faster, ${slower.length} slower, ${paired - moved.length} unchanged, ${unpaired.length} unpaired\n`);
