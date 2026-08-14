/**
 * Calibration workload: a fixed amount of pure arithmetic whose only variable is
 * how fast the host is. Hosted runners vary between jobs by more than a real
 * regression does, so the report scales every other benchmark by this one before
 * comparing a pull request against the baseline.
 *
 * It must stay untouched. Changing it invalidates the comparison for every other
 * benchmark, the same way changing a ruler invalidates old measurements.
 */

import { bench, describe } from 'vitest';

describe('reference', () => {
	bench('calibration', () => {
		const data = new Float64Array(4096);
		let checksum = 0;
		for (let round = 1; round <= 64; round++) {
			for (let index = 0; index < data.length; index++) {
				data[index] = (data[index] + index * 0.5) % round;
				checksum += data[index];
			}
		}
		// Consume the result so the loop cannot be optimized away.
		if (!Number.isFinite(checksum)) {
			throw new TypeError('calibration diverged');
		}
	}, { time: 1000 });
});
