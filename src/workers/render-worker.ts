/**
 * Worker entry: rebuilds the run's resource tree from its descriptor, then
 * renders, encodes and writes items on demand. Items are written here rather
 * than shipped back as buffers — the main thread only needs the outcome, and
 * the file write is the run's success signal either way.
 *
 * Messages in are `{ id }`; messages out are `{ id, result }` or `{ id, error }`.
 * Errors cross as strings because Error instances lose their type across the
 * structured-clone boundary.
 */

import { parentPort, workerData } from 'node:worker_threads';

import sharp from 'sharp';

import { ItemPipeline } from '../render/pipeline.ts';
import { restoreResources } from '../resources/descriptor.ts';

import type { ItemRenderOutcome, PipelineSettings } from '../render/pipeline.ts';
import type { ResourceDescriptor } from '../resources/descriptor.ts';

export interface RenderWorkerData {
	resources: ResourceDescriptor;
	settings: PipelineSettings;
	/** libvips threads per worker; the pool already saturates the CPU. */
	sharpConcurrency: number;
}

export interface RenderWorkerTask {
	id: string;
}

export type RenderWorkerOutcome = ItemRenderOutcome;

if (!parentPort) {
	throw new Error('render-worker must be started as a worker thread');
}
const port = parentPort;
const data = workerData as RenderWorkerData;

// Each worker would otherwise start a libvips threadpool sized to the whole
// machine, so N workers oversubscribe the CPU by N×.
sharp.concurrency(data.sharpConcurrency);

const pipeline = await ItemPipeline.create(restoreResources(data.resources), data.settings);

async function handle(task: RenderWorkerTask): Promise<void> {
	try {
		const result = await pipeline.renderItem(task.id);
		// eslint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads postMessage has no targetOrigin
		port.postMessage({ id: task.id, result });
	} catch (err) {
		// eslint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads postMessage has no targetOrigin
		port.postMessage({ id: task.id, error: (err as Error).message });
	}
}

port.on('message', (task: RenderWorkerTask) => {
	// Deliberately not awaited: the pool sends several tasks at once so encoding
	// (native, off-thread) overlaps the next item's rasterization.
	handle(task).catch(() => {
		// handle() reports its own failures; nothing here can be posted twice.
	});
});
// eslint-disable-next-line unicorn/require-post-message-target-origin -- worker_threads postMessage has no targetOrigin
port.postMessage({ ready: true });
