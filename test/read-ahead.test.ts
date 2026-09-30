import { describe, expect, it } from 'vitest';

import { readAhead } from '../src/resources/read-ahead.ts';

const delay = (ms: number): Promise<void> => new Promise((resolve) => {
	setTimeout(resolve, ms);
});

describe('readAhead', () => {
	it('yields in input order however the loads finish', async () => {
		const seen: number[] = [];
		// Later items finish first, so a result handed out as it lands would come back reversed
		for (const [item, pending] of readAhead([5, 4, 3, 2, 1], async (value) => {
			await delay(value * 5);
			return value * 10;
		})) {
			seen.push(item, await pending);
		}
		expect(seen).toEqual([5, 50, 4, 40, 3, 30, 2, 20, 1, 10]);
	});

	it('reports a failure at its own position, including a synchronous throw', async () => {
		const outcomes: string[] = [];
		for (const [item, pending] of readAhead(['a', 'bad', 'c'], (value) => {
			if (value === 'bad') {
				throw new Error('unreadable');
			}
			return Promise.resolve(value);
		})) {
			try {
				outcomes.push(await pending);
			} catch (err) {
				outcomes.push(`${item}: ${(err as Error).message}`);
			}
		}
		expect(outcomes).toEqual(['a', 'bad: unreadable', 'c']);
	});

	it('keeps a bounded number of loads in flight', async () => {
		let running = 0;
		let peak = 0;
		for (const [, pending] of readAhead(Array.from({ length: 100 }, (_, index) => index), async () => {
			running++;
			peak = Math.max(peak, running);
			await delay(1);
			running--;
		})) {
			await pending;
		}
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(32);
	});
});
