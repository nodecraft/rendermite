/**
 * Worker-thread pool for parallel item rendering. Design goals born from the
 * PHP tool's failure modes (docs/research/mod-failure-taxonomy.md): errors
 * cross the worker boundary as structured data, a dead worker's in-flight items
 * are reported rather than orphaned, and results stream back so output lands
 * incrementally.
 *
 * Workers spawn as soon as the pool is constructed, so their asset indexing
 * overlaps the caller's own discovery pass; each holds several tasks at once so
 * native encoding overlaps the next item's rasterization; and the queue drains
 * through a cursor, because shift() on a 400k-item array is quadratic.
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
	/** Worker threads to spawn. */
	workers: number;
	/** Tasks held by each worker at once (default 2). */
	inFlight?: number;
}

interface PoolWorker {
	worker: Worker;
	inFlight: Set<string>;
	ready: boolean;
	stopped: boolean;
}

export class WorkerRenderPool<T> {
	private readonly options: PoolOptions;
	private readonly inFlightLimit: number;
	private readonly workers = new Set<PoolWorker>();
	private tasks: WorkerTask[] = [];
	private cursor = 0;
	private started = false;
	private onResult: ((result: WorkerResult<T>) => void) | null = null;
	private settle: { resolve: () => void; reject: (err: Error) => void; } | null = null;
	private settled = false;
	/** Workers dying before completing anything mean a bad config, not bad luck. */
	private startupFailures = 0;

	constructor(options: PoolOptions) {
		this.options = options;
		this.inFlightLimit = Math.max(1, options.inFlight ?? 2);
		for (let i = 0; i < Math.max(1, options.workers); i++) {
			this.spawn();
		}
	}

	private spawn(): void {
		const entry: PoolWorker = {
			worker: new Worker(this.options.workerUrl, { workerData: this.options.workerData }),
			inFlight: new Set(),
			ready: false,
			stopped: false,
		};
		this.workers.add(entry);

		entry.worker.on('message', (message: WorkerResult<T> | { ready: true; }) => {
			if ('ready' in message) {
				entry.ready = true;
			} else {
				entry.inFlight.delete(message.id);
				this.startupFailures = 0;
				this.onResult?.(message);
			}
			this.pump(entry);
		});
		entry.worker.on('error', (err) => {
			if (entry.inFlight.size === 0) {
				this.startupFailures++;
				if (this.startupFailures > 3) {
					this.abort(err);
					return;
				}
			}
			this.fail(entry, `Worker crashed: ${err.message}`);
		});
		entry.worker.on('exit', (code) => {
			if (code !== 0) {
				this.fail(entry, `Worker exited with code ${code}`);
			}
		});
	}

	private pump(entry: PoolWorker): void {
		if (!this.started || entry.stopped || !entry.ready) {
			return;
		}
		while (entry.inFlight.size < this.inFlightLimit && this.cursor < this.tasks.length) {
			const task = this.tasks[this.cursor++];
			entry.inFlight.add(task.id);
			// eslint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads postMessage has no targetOrigin
			entry.worker.postMessage(task);
		}
		if (entry.inFlight.size === 0 && this.cursor >= this.tasks.length) {
			this.retire(entry);
		}
	}

	private retire(entry: PoolWorker): void {
		if (entry.stopped) {
			return;
		}
		entry.stopped = true;
		this.workers.delete(entry);
		entry.worker.terminate().catch(() => {});
		this.finish();
	}

	private fail(entry: PoolWorker, reason: string): void {
		if (entry.stopped) {
			return;
		}
		// A dead worker must not orphan its items: report each with the real
		// reason, then let a replacement pick up the rest of the queue.
		for (const id of entry.inFlight) {
			this.onResult?.({ id, error: reason });
		}
		entry.inFlight.clear();
		entry.stopped = true;
		this.workers.delete(entry);
		if (this.started && this.cursor < this.tasks.length) {
			this.spawn();
		} else {
			this.finish();
		}
	}

	private finish(): void {
		if (!this.settled && this.started && this.workers.size === 0) {
			this.settled = true;
			this.settle?.resolve();
		}
	}

	private abort(err: Error): void {
		if (this.settled) {
			return;
		}
		this.settled = true;
		for (const entry of this.workers) {
			entry.stopped = true;
			entry.worker.terminate().catch(() => {});
		}
		this.workers.clear();
		this.settle?.reject(err);
	}
	/** Run every task, calling back as results arrive. Terminates the pool after. */
	async run(tasks: WorkerTask[], onResult: (result: WorkerResult<T>) => void): Promise<void> {
		this.tasks = tasks;
		this.onResult = onResult;
		this.started = true;
		try {
			if (tasks.length > 0) {
				await new Promise<void>((resolve, reject) => {
					this.settle = { resolve, reject };
					for (const entry of this.workers) {
						this.pump(entry);
					}
				});
			}
		} finally {
			await this.close();
		}
	}

	async close(): Promise<void> {
		const workers = [...this.workers];
		this.workers.clear();
		await Promise.all(workers.map(entry => entry.worker.terminate().catch(() => {})));
	}
}
