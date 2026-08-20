/**
 * Registers every workload once per side, so a base `src/` and this tree's are
 * measured adjacent in a single process.
 *
 * Two runs cannot do this. The report this replaced compared a pull request
 * against a JSON artifact produced by an earlier job on a different hosted
 * runner, and runner-to-runner drift moves every number by more than most real
 * regressions do. A run where the whole table shifts one way, calibration
 * included, is measuring the machine, not the change.
 *
 * `scripts/bench-against.ts` supplies the base side by checking the ref out into
 * `.bench/base` and dropping this tree's `bench/subject.ts` into it. Without
 * that env variable, as in a plain `npm run bench`, only the head cases register.
 */

import { bench, describe } from 'vitest';

export type Subject = typeof import('./subject.ts');

/** Must match `GROUP_SEPARATOR` and `CASE_NAMES` in `scripts/bench-comment.ts`. */
export const GROUP_SEPARATOR = ' :: ';

/**
 * Case names within a group, registered in this order.
 *
 * A palindrome, and that is the whole point: tinybench runs cases in
 * registration order and the second one inherits a JIT and caches the first
 * warmed. Giving each side one early slot and one late slot lets the comparison
 * take the better of each and demand that both orderings agree.
 */
export const CASES = ['base', 'head', 'head2', 'base2'] as const;

/**
 * `iterations` is a floor and `time` a target: tinybench runs until both are
 * met. `setup` collects garbage between cases where the runtime allows it
 * (`scripts/bench-against.ts` passes `--expose-gc`); without it the second case
 * of a pair inherits the heap the first dirtied, which matters here because
 * every render allocates float buffers by the megabyte.
 */
const OPTIONS = {
	iterations: 5,
	warmupTime: 250,
	warmupIterations: 2,
	setup: (): void => {
		(globalThis as { gc?: () => void; }).gc?.();
	},
} as const;

const baseDirectory = process.env.RENDERMITE_BENCH_BASE ?? '';

/*
 * A computed specifier, so Vite leaves it alone and resolves it at runtime; it
 * stays inside the project root, which is why it resolves at all.
 *
 * An export this tree added and the base ref lacks makes this throw. That is
 * reported and the run continues head-only rather than failing outright, since
 * a table of unpaired rows still tells a reviewer something.
 */
let baseSubject: Subject | null = null;
if (baseDirectory) {
	try {
		baseSubject = await import(/* @vite-ignore */ `${baseDirectory}/subject.ts`) as Subject;
	} catch (error) {
		process.stderr.write(`\n[bench] base tree failed to load, measuring this tree only: ${String(error)}\n\n`);
	}
}

export interface Sides<Context> {
	/** Registers one workload as `<area> :: <workload>`, one case per side. */
	compare: (area: string, workload: string, options: { time: number; }, run: (context: Context) => Promise<unknown> | unknown) => void;
}

/**
 * Runs `setup` once per side and hands back a registrar for its workloads.
 *
 * Setup is per side by necessity, not convenience: a base-side benchmark has to
 * be fed models, textures and buffers built by the base tree's own code, and it
 * has to start from caches as warm as the head side's.
 */
export async function prepareSides<Context>(setup: (subject: Subject) => Promise<Context> | Context): Promise<Sides<Context>> {
	const head = await setup(await import('./subject.ts'));
	let base: Context | null = null;
	if (baseSubject) {
		try {
			base = await setup(baseSubject);
		} catch (error) {
			// A pull request that fixes a crash legitimately hits this; the base
			// side drops out and the comparison degrades rather than the run dying.
			process.stderr.write(`\n[bench] base tree setup failed, measuring this tree only: ${String(error)}\n\n`);
		}
	}

	// A const, so its null check narrows inside the closures below
	const baseContext = base;

	return {
		compare(area, workload, options, run) {
			describe([area, workload].join(GROUP_SEPARATOR), () => {
				if (!baseContext) {
					bench('head', async () => {
						await run(head);
					}, { ...OPTIONS, ...options });
					return;
				}
				for (const label of CASES) {
					const context = label.startsWith('base') ? baseContext : head;
					bench(label, async () => {
						await run(context);
					}, { ...OPTIONS, ...options });
				}
			});
		},
	};
}
