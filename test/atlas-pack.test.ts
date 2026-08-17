/**
 * Atlas packing for the block pack: everything fits, nothing overlaps, and the
 * padding is edge-extended rather than transparent — a transparent gutter is
 * what makes block seams glow the moment anything downscales.
 */

import { describe, expect, it } from 'vitest';

import { packAtlas } from '../src/blocks/atlas-pack.ts';

import type { PackEntry, PackedAtlas } from '../src/blocks/atlas-pack.ts';
import type { Texture } from '../src/textures/loader.ts';

/** A solid texture, with its top-left pixel distinguishable for edge checks. */
function solid(width: number, height: number, red: number, corner = red): Texture {
	const data = new Uint8ClampedArray(width * height * 4);
	for (let index = 0; index < width * height; index++) {
		data.set([red, 20, 30, 255], index * 4);
	}
	data.set([corner, 20, 30, 255], 0);
	return { width, height, data };
}

function entries(count: number, size = 16): PackEntry[] {
	return Array.from({ length: count }, (_, index) => {
		return {
			key: `example:block/sprite_${index}`,
			texture: solid(size, size, index % 256),
		};
	});
}

function pixel(atlas: PackedAtlas, page: number, x: number, y: number): [number, number, number, number] {
	const target = atlas.pages[page];
	const offset = (y * target.width + x) * 4;
	return [target.data[offset], target.data[offset + 1], target.data[offset + 2], target.data[offset + 3]];
}

describe('atlas packer', () => {
	it('places every sprite inside its page', () => {
		const atlas = packAtlas(entries(200));
		expect(atlas.rects).toHaveLength(200);
		expect(atlas.oversized).toEqual([]);
		for (const rect of atlas.rects) {
			const page = atlas.pages[rect.page];
			expect(rect.x).toBeGreaterThanOrEqual(atlas.padding);
			expect(rect.y).toBeGreaterThanOrEqual(atlas.padding);
			expect(rect.x + rect.width + atlas.padding).toBeLessThanOrEqual(page.width);
			expect(rect.y + rect.height + atlas.padding).toBeLessThanOrEqual(page.height);
		}
	});

	it('never overlaps two sprites, padding included', () => {
		const atlas = packAtlas([...entries(60, 16), ...entries(20, 32), ...entries(5, 64)]);
		const boxes = atlas.rects.map((rect) => {
			return {
				page: rect.page,
				left: rect.x - atlas.padding,
				top: rect.y - atlas.padding,
				right: rect.x + rect.width + atlas.padding,
				bottom: rect.y + rect.height + atlas.padding,
			};
		});
		for (const [index, box] of boxes.entries()) {
			for (const other of boxes.slice(index + 1)) {
				const overlaps = box.page === other.page
					&& box.left < other.right && other.left < box.right
					&& box.top < other.bottom && other.top < box.bottom;
				expect(overlaps).toBe(false);
			}
		}
	});

	it('emits power-of-two page dimensions', () => {
		for (const page of packAtlas(entries(500)).pages) {
			expect(Number.isSafeInteger(Math.log2(page.width))).toBe(true);
			expect(Number.isSafeInteger(Math.log2(page.height))).toBe(true);
		}
	});

	it('extends edge pixels into the padding instead of leaving it transparent', () => {
		const atlas = packAtlas([{ key: 'example:block/one', texture: solid(16, 16, 200, 111) }], { padding: 4 });
		const rect = atlas.rects[0];
		// Directly left of the sprite's top-left pixel: the same colour, opaque.
		expect(pixel(atlas, rect.page, rect.x - 1, rect.y)).toEqual([111, 20, 30, 255]);
		// The diagonal corner clamps on both axes, so it is that pixel too.
		expect(pixel(atlas, rect.page, rect.x - 4, rect.y - 4)).toEqual([111, 20, 30, 255]);
		// Right of the sprite it is the body colour, still opaque.
		expect(pixel(atlas, rect.page, rect.x + 16, rect.y + 8)).toEqual([200, 20, 30, 255]);
	});

	it('spills onto more pages rather than dropping sprites', () => {
		const atlas = packAtlas(entries(400, 16), { maxPageSize: 128 });
		expect(atlas.pages.length).toBeGreaterThan(1);
		expect(atlas.rects).toHaveLength(400);
		expect(new Set(atlas.rects.map(rect => rect.page)).size).toBe(atlas.pages.length);
	});

	it('reports a sprite too large for any page instead of packing it', () => {
		const atlas = packAtlas([
			{ key: 'example:block/huge', texture: solid(256, 256, 1) },
			{ key: 'example:block/fine', texture: solid(16, 16, 2) },
		], { maxPageSize: 128 });
		expect(atlas.oversized).toEqual(['example:block/huge']);
		expect(atlas.rects.map(rect => rect.key)).toEqual(['example:block/fine']);
	});

	it('stays under a ceiling that is not a power of two', () => {
		// Both axes have their own way of overrunning: width by doubling past the
		// ceiling as pages spill, height by rounding the used shelves up.
		const wide = Array.from({ length: 100 }, (_, index) => {
			return { key: `example:block/wide_${index}`, texture: solid(1100, 16, index % 256) };
		});
		const runs = [
			// Spills, so the doubling loop runs; it must stop at 2048, not 4096.
			{ ceiling: 3000, atlas: packAtlas(wide, { maxPageSize: 3000 }) },
			{ ceiling: 1000, atlas: packAtlas(entries(40, 300), { maxPageSize: 1000 }) },
			{ ceiling: 1000, atlas: packAtlas([{ key: 'example:block/one', texture: solid(800, 600, 1) }], { maxPageSize: 1000 }) },
		];
		for (const { ceiling, atlas } of runs) {
			for (const page of atlas.pages) {
				expect(page.width).toBeLessThanOrEqual(ceiling);
				expect(page.height).toBeLessThanOrEqual(ceiling);
				expect(Number.isSafeInteger(Math.log2(page.width))).toBe(true);
				expect(Number.isSafeInteger(Math.log2(page.height))).toBe(true);
			}
		}
	});

	it('rejects option values that would silently empty the atlas', () => {
		expect(() => packAtlas(entries(4), { maxPageSize: Number('abc') })).toThrow(RangeError);
		expect(() => packAtlas(entries(4), { maxPageSize: -1 })).toThrow(RangeError);
		expect(() => packAtlas(entries(4), { padding: -1 })).toThrow(RangeError);
	});

	it('packs an empty run without producing a zero-sized page', () => {
		const atlas = packAtlas([]);
		expect(atlas.rects).toEqual([]);
		expect(atlas.pages[0].width).toBeGreaterThan(0);
		expect(atlas.pages[0].height).toBeGreaterThan(0);
	});
});
