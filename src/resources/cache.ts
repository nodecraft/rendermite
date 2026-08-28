/**
 * Least-recently-used map used by the model and texture loaders. Their caches
 * were unbounded, which is fine for one namespace and not fine for a run that
 * walks thousands of them in a single process — resident memory only ever grew.
 */
export class LruCache<K, V> {
	private readonly entries = new Map<K, V>();
	private readonly maxEntries: number;
	private readonly weigh: (value: V) => number;
	private readonly maxWeight: number;
	private readonly weights = new Map<K, number>();
	private weight = 0;

	constructor(maxEntries: number, options: { maxWeight?: number; weigh?: (value: V) => number; } = {}) {
		this.maxEntries = Math.max(1, maxEntries);
		this.maxWeight = options.maxWeight ?? Infinity;
		this.weigh = options.weigh ?? (() => 0);
	}

	private evict(): void {
		while (this.entries.size > this.maxEntries || (this.weight > this.maxWeight && this.entries.size > 1)) {
			const oldest = this.entries.keys().next();
			if (oldest.done) {
				return;
			}
			this.weight -= this.weights.get(oldest.value) ?? 0;
			this.weights.delete(oldest.value);
			this.entries.delete(oldest.value);
		}
	}
	get size(): number {
		return this.entries.size;
	}

	get(key: K): V | undefined {
		const value = this.entries.get(key);
		if (value !== undefined) {
			// Re-insert to move the key to the end of the eviction order.
			this.entries.delete(key);
			this.entries.set(key, value);
		}
		return value;
	}

	set(key: K, value: V): void {
		if (this.entries.has(key)) {
			this.weight -= this.weights.get(key) ?? 0;
			this.entries.delete(key);
		}
		this.entries.set(key, value);
		this.weights.set(key, 0);
		this.evict();
	}

	/**
	 * Record a value's real cost once it is known. Loaders cache promises, so the
	 * weight of a decoded texture only exists after it resolves.
	 */
	settle(key: K, value: V): void {
		if (!this.entries.has(key)) {
			return;
		}
		const size = this.weigh(value);
		this.weight += size - (this.weights.get(key) ?? 0);
		this.weights.set(key, size);
		this.evict();
	}

	delete(key: K): void {
		if (!this.entries.has(key)) {
			return;
		}
		this.weight -= this.weights.get(key) ?? 0;
		this.weights.delete(key);
		this.entries.delete(key);
	}

	clear(): void {
		this.entries.clear();
		this.weights.clear();
		this.weight = 0;
	}
}
