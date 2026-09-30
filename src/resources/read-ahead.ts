/** Loads kept running ahead of the caller: enough to overlap one entry's decode with the next one's I/O. */
const WINDOW = 32;

/**
 * Each item paired with its load, already started, in the order given; a fixed number of loads run
 * ahead of the one the caller is awaiting.
 *
 * Whole-jar sweeps and atlas builds awaited one entry at a time, so every read paid its disk round trip
 * and decode in series. The caller still awaits each load in order, so results, progress and the first
 * failure land exactly where the one-at-a-time loop put them.
 */
export function *readAhead<Item, Result>(items: Iterable<Item>, load: (item: Item) => Promise<Result>): Generator<[Item, Promise<Result>]> {
	const iterator = items[Symbol.iterator]();
	const pending: Array<[Item, Promise<Result>]> = [];
	const fill = (): void => {
		while (pending.length < WINDOW) {
			const next = iterator.next();
			if (next.done) {
				return;
			}
			const result = Promise.try(load, next.value);
			// A load past a failure the caller stops at is never awaited, and must not surface as unhandled
			result.catch(() => {});
			pending.push([next.value, result]);
		}
	};
	fill();
	for (let entry = pending.shift(); entry; entry = pending.shift()) {
		// Topped up only once the caller moves on, so the load it is awaiting counts toward the window
		yield entry;
		fill();
	}
}
