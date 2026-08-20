/**
 * Calibration workload: a fixed amount of pure arithmetic that touches no
 * source at all, registered on both sides like every other benchmark.
 *
 * Because the two sides run byte-identical code, whatever gap the report shows
 * for this group is the harness's own floor for this run: how far apart two
 * copies of the same thing land on this machine, today. A calibration that
 * reads near zero says the rest of the table can be trusted; one that reads 12%
 * says the run was contaminated and every other row is suspect.
 *
 * It must stay untouched. Changing it changes the ruler.
 */

import { prepareSides } from './sides.ts';

function calibrate(): void {
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
}

// The subject is deliberately ignored: both sides get the same function.
const sides = await prepareSides(() => calibrate);

sides.compare('reference', 'calibration', { time: 1000 }, (run) => {
	run();
});
