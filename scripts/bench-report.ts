/**
 * Normalizes Vitest's benchmark output into a small, stable report, and (with
 * `--comment <file>` plus BASE_BENCH_JSON) renders a markdown delta table for a
 * sticky pull-request comment. Monitoring, not a gate.
 *
 * Hosted runners differ in speed between jobs by more than most real
 * regressions, so raw milliseconds cannot be compared across two runs. Every
 * benchmark is therefore also reported scaled by the `reference > calibration`
 * benchmark — a fixed arithmetic workload measured in the same run — which
 * cancels out most of the host difference. The scaled column is the one worth
 * reading; the raw one is kept because a calibration that itself moved is worth
 * seeing.
 *
 * Usage:
 *   vitest bench --config vitest.bench.config.ts --run --outputJson bench-results.json
 *   node scripts/bench-report.ts [--comment bench-comment.md]
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resultsPath = path.resolve(repoRoot, process.env.BENCH_RESULTS_JSON ?? 'bench-results.json');
const reportPath = path.resolve(repoRoot, 'bench-report.json');
const CALIBRATION = 'reference > calibration';
/** Scaled moves smaller than this are indistinguishable from runner noise. */
const NOTABLE_PERCENT = 10;

interface VitestBenchmark {
	name: string;
	mean?: number;
	hz?: number;
	rme?: number;
	sampleCount?: number;
}

interface VitestBenchFile {
	filepath?: string;
	groups?: Array<{ fullName?: string; benchmarks?: VitestBenchmark[]; }>;
}

interface Measurement {
	meanMs: number;
	hz: number;
	rmePercent: number;
	samples: number;
}

interface Report {
	version: 1;
	node: string;
	platform: string;
	cpus: number;
	benchmarks: Record<string, Measurement>;
}

/** `bench/render.bench.ts > render` → `render`; a file-level bench keeps its file. */
function groupLabel(fullName: string | undefined, filepath: string | undefined): string {
	if (!fullName) {
		return filepath ? path.basename(filepath).replace(/\.bench\.ts$/, '') : 'bench';
	}
	const parts = fullName.split(' > ');
	return parts.length > 1 ? parts.slice(1).join(' > ') : parts[0];
}

const raw = JSON.parse(await readFile(resultsPath, 'utf8')) as { files?: VitestBenchFile[]; };
const benchmarks: Record<string, Measurement> = {};
for (const file of raw.files ?? []) {
	for (const group of file.groups ?? []) {
		for (const benchmark of group.benchmarks ?? []) {
			if (benchmark.mean === undefined || benchmark.mean <= 0) {
				// A benchmark with no samples measured nothing; reporting it as fast
				// would be worse than failing here.
				throw new Error(`Benchmark "${benchmark.name}" produced no timing — check its setup`);
			}
			benchmarks[`${groupLabel(group.fullName, file.filepath)} > ${benchmark.name}`] = {
				meanMs: benchmark.mean,
				hz: benchmark.hz ?? 0,
				rmePercent: benchmark.rme ?? 0,
				samples: benchmark.sampleCount ?? 0,
			};
		}
	}
}
if (!benchmarks[CALIBRATION]) {
	throw new Error(`Missing "${CALIBRATION}"; comparisons across hosts depend on it`);
}

const report: Report = {
	version: 1,
	node: process.version,
	platform: `${process.platform}-${process.arch}`,
	cpus: os.availableParallelism(),
	benchmarks,
};
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

const commentIndex = process.argv.indexOf('--comment');
const commentPath = commentIndex === -1 ? undefined : process.argv[commentIndex + 1];

const basePath = process.env.BASE_BENCH_JSON;
const base: Report | null = basePath && existsSync(basePath)
	? JSON.parse(await readFile(basePath, 'utf8')) as Report
	: null;
// How much slower this host is than the baseline's, from the calibration alone.
const scale = base?.benchmarks[CALIBRATION]
	? base.benchmarks[CALIBRATION].meanMs / benchmarks[CALIBRATION].meanMs
	: 1;

const ms = (value: number): string => (value >= 10 ? value.toFixed(1) : value.toFixed(3));
const percent = (current: number, previous: number): number => ((current - previous) / previous) * 100;
const delta = (current: number, previous: number | undefined): string => {
	if (previous === undefined) {
		return 'new';
	}
	const change = percent(current, previous);
	if (Math.abs(change) < 0.05) {
		return '–';
	}
	return `${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%`;
};

const rows: string[] = [];
const regressions: string[] = [];
const improvements: string[] = [];
for (const [name, current] of Object.entries(benchmarks)) {
	const previous = base?.benchmarks[name];
	const scaled = current.meanMs * scale;
	rows.push(`| ${[
		name,
		`${ms(current.meanMs)} ms`,
		`±${current.rmePercent.toFixed(1)}%`,
		delta(current.meanMs, previous?.meanMs),
		previous ? delta(scaled, previous.meanMs) : 'new',
	].join(' | ')} |`);
	if (!previous || name === CALIBRATION) {
		continue;
	}
	const change = percent(scaled, previous.meanMs);
	// Only call it a move if it clears the noise this run actually measured.
	if (Math.abs(change) > Math.max(NOTABLE_PERCENT, current.rmePercent + previous.rmePercent)) {
		(change > 0 ? regressions : improvements).push(`\`${name}\` ${change > 0 ? '+' : '−'}${Math.abs(change).toFixed(1)}%`);
	}
}

const heading = base
	? `#### Benchmarks vs \`main\`${Math.abs(scale - 1) > 0.05 ? ` <sub>(runner ${scale > 1 ? 'slower' : 'faster'} than baseline; scaled column corrects for it)</sub>` : ''}`
	: '#### Benchmarks (no `main` baseline yet)';

const notes: string[] = [];
if (regressions.length > 0) {
	notes.push(`**Slower:** ${regressions.join(', ')}`);
}
if (improvements.length > 0) {
	notes.push(`**Faster:** ${improvements.join(', ')}`);
}
if (base && notes.length === 0) {
	notes.push('No move beyond measurement noise.');
}

const md = [
	heading,
	'',
	'| Benchmark | Mean | Noise | Δ raw | Δ scaled |',
	'| --- | ---: | ---: | ---: | ---: |',
	...rows,
	'',
	...notes.length > 0 ? [notes.join('\n\n'), ''] : [],
	`<sub>Mean time per iteration on \`${report.platform}\`, Node ${report.node}, ${report.cpus} threads.`
	+ ' Δ scaled divides out the host speed difference using the `reference > calibration` benchmark.'
	+ ` Moves under ${NOTABLE_PERCENT}% (or within the run's noise) are not called out. Monitoring only — not a gate.</sub>`,
].join('\n');

if (commentPath === undefined) {
	console.log(`bench-report.json written (${Object.keys(benchmarks).length} benchmarks)`);
} else {
	await writeFile(path.resolve(repoRoot, commentPath), `${md}\n`);
	console.log(md);
}
