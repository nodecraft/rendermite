/**
 * Worker-thread pool for parallel item rendering. Design goals born from the
 * PHP tool's failure modes (docs/research/mod-failure-taxonomy.md): errors
 * cross the worker boundary as structured data, a dead worker's queue items are
 * requeued not orphaned, and results stream back so output lands incrementally.
 */

import { Worker } from 'node:worker_threads';

export interface WorkerTask {
	id: string;
}

export interface WorkerResult<T> {
	id: string;
	result?: T;
	error?: string;
}

export interface PoolOptions {
	workerUrl: URL;
	workerData: unknown;
	concurrency: number;
}

export async function runPool<T>(
	tasks: WorkerTask[],
	options: PoolOptions,
	onResult: (result: WorkerResult<T>) => void,
): Promise<void> {
	const queue = [...tasks];
	const inFlight = new Map<Worker, WorkerTask>();

	await new Promise<void>((resolve) => {
		let active = 0;

		const spawn = (): void => {
			const worker = new Worker(options.workerUrl, { workerData: options.workerData });
			active++;

			const next = (): void => {
				const task = queue.shift();
				if (task === undefined) {
					worker.terminate().catch(() => {});
					active--;
					if (active === 0) {
						resolve();
					}
					return;
				}
				inFlight.set(worker, task);
				// eslint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads postMessage has no targetOrigin
				worker.postMessage(task);
			};

			worker.on('message', (message: WorkerResult<T>) => {
				inFlight.delete(worker);
				onResult(message);
				next();
			});

			worker.on('error', (err) => {
				// A crashed worker must not orphan its task: report it as failed with
				// the real error, then replace the worker.
				const task = inFlight.get(worker);
				inFlight.delete(worker);
				if (task) {
					onResult({ id: task.id, error: `Worker crashed: ${err.message}` });
				}
				active--;
				if (queue.length > 0) {
					spawn();
				} else if (active === 0) {
					resolve();
				}
			});

			worker.on('exit', (code) => {
				// Non-zero exit without a preceding error event — same recovery path.
				const task = inFlight.get(worker);
				if (task && code !== 0) {
					inFlight.delete(worker);
					onResult({ id: task.id, error: `Worker exited with code ${code}` });
					active--;
					if (queue.length > 0) {
						spawn();
					} else if (active === 0) {
						resolve();
					}
				}
			});

			next();
		};

		if (queue.length === 0) {
			resolve();
			return;
		}
		for (let i = 0; i < Math.min(options.concurrency, queue.length); i++) {
			spawn();
		}
	});
}
