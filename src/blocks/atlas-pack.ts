/**
 * Stitch block sprites into power-of-two atlas pages.
 *
 * Two things here are not incidental. Sprites are padded with **edge-extended**
 * pixels rather than transparency: a transparent gutter bleeds into the sprite
 * as soon as the consumer mips or downscales, and it shows up as bright seams
 * between blocks. And every animation frame is packed as its own rect, so the
 * consumer swaps UVs per tick instead of blitting into a live texture.
 *
 * A shelf packer is ample at this scale — vanilla is ~1,300 sprites that are
 * almost all 16x16, and the sort by descending height leaves very little waste.
 */

import type { Texture } from '../textures/loader.ts';

export interface PackEntry {
	/** Caller's identifier; carried through to the emitted rect. */
	key: string;
	texture: Texture;
}

export interface PackedRect {
	key: string;
	page: number;
	/** Position of the sprite itself, inside its padding. */
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface PackedPage {
	width: number;
	height: number;
	/** RGBA, row-major. */
	data: Uint8ClampedArray;
}

export interface PackedAtlas {
	pages: PackedPage[];
	rects: PackedRect[];
	/** Entries too large for a single page — reported, never dropped silently. */
	oversized: string[];
	padding: number;
}

export interface PackOptions {
	/** Edge-extended border per side, in pixels. */
	padding?: number;
	/** Hard ceiling on a page's dimensions; GPUs and browsers both cap this. */
	maxPageSize?: number;
}

const DEFAULT_PADDING = 4;
const DEFAULT_MAX_PAGE_SIZE = 4096;

function nextPowerOfTwo(value: number): number {
	let size = 1;
	while (size < value) {
		size *= 2;
	}
	return size;
}

interface Shelf {
	y: number;
	height: number;
	cursor: number;
}

interface Placement {
	entry: PackEntry;
	page: number;
	x: number;
	y: number;
}

/**
 * Lay entries out at a fixed page width, opening a new page when the current
 * one runs out of shelf room. Returns the placements plus the used height of
 * every page, so the caller can trim the last one.
 */
function shelvePlacements(entries: PackEntry[], pageSize: number, padding: number): {
	placements: Placement[];
	usedHeights: number[];
} {
	const placements: Placement[] = [];
	const usedHeights: number[] = [0];
	let shelves: Shelf[] = [];
	let page = 0;
	for (const entry of entries) {
		const width = entry.texture.width + padding * 2;
		const height = entry.texture.height + padding * 2;
		// Entries arrive tallest-first, so the first shelf with room is a good fit.
		let shelf = shelves.find(candidate => candidate.height >= height && candidate.cursor + width <= pageSize);
		if (!shelf) {
			if (usedHeights[page] + height > pageSize) {
				page++;
				shelves = [];
				usedHeights[page] = 0;
			}
			shelf = { y: usedHeights[page], height, cursor: 0 };
			shelves.push(shelf);
			usedHeights[page] += height;
		}
		placements.push({ entry, page, x: shelf.cursor + padding, y: shelf.y + padding });
		shelf.cursor += width;
	}
	return { placements, usedHeights };
}

/**
 * Copy a sprite into a page, extending its edge pixels outward across the
 * padding by clamping the sample coordinates.
 */
function blit(page: PackedPage, texture: Texture, left: number, top: number, padding: number): void {
	for (let y = -padding; y < texture.height + padding; y++) {
		const sourceY = Math.min(texture.height - 1, Math.max(0, y));
		for (let x = -padding; x < texture.width + padding; x++) {
			const sourceX = Math.min(texture.width - 1, Math.max(0, x));
			const source = (sourceY * texture.width + sourceX) * 4;
			const target = ((top + y) * page.width + (left + x)) * 4;
			page.data[target] = texture.data[source];
			page.data[target + 1] = texture.data[source + 1];
			page.data[target + 2] = texture.data[source + 2];
			page.data[target + 3] = texture.data[source + 3];
		}
	}
}

export function packAtlas(entries: PackEntry[], options: PackOptions = {}): PackedAtlas {
	const padding = options.padding ?? DEFAULT_PADDING;
	const maxPageSize = options.maxPageSize ?? DEFAULT_MAX_PAGE_SIZE;

	const oversized: string[] = [];
	const packable: PackEntry[] = [];
	for (const entry of entries) {
		const fits = entry.texture.width + padding * 2 <= maxPageSize
			&& entry.texture.height + padding * 2 <= maxPageSize;
		if (fits) {
			packable.push(entry);
		} else {
			oversized.push(entry.key);
		}
	}

	packable.sort((left, right) => (right.texture.height - left.texture.height)
		|| (right.texture.width - left.texture.width)
		|| left.key.localeCompare(right.key));

	// Start from the area-implied square and grow: vanilla lands on one page,
	// a large modpack spills onto several at the ceiling.
	let area = 0;
	let widest = 1;
	for (const entry of packable) {
		area += (entry.texture.width + padding * 2) * (entry.texture.height + padding * 2);
		widest = Math.max(widest, entry.texture.width + padding * 2);
	}
	let pageSize = Math.min(maxPageSize, Math.max(nextPowerOfTwo(widest), nextPowerOfTwo(Math.ceil(Math.sqrt(area)))));
	let layout = shelvePlacements(packable, pageSize, padding);
	while (layout.usedHeights.length > 1 && pageSize < maxPageSize) {
		pageSize *= 2;
		layout = shelvePlacements(packable, pageSize, padding);
	}

	const pages: PackedPage[] = layout.usedHeights.map((used) => {
		// Trim to the shortest power-of-two that holds the shelves actually used;
		// the last page of a spilled run is usually mostly empty.
		const height = Math.max(1, nextPowerOfTwo(used));
		return { width: pageSize, height, data: new Uint8ClampedArray(pageSize * height * 4) };
	});
	const rects: PackedRect[] = [];
	for (const placement of layout.placements) {
		blit(pages[placement.page], placement.entry.texture, placement.x, placement.y, padding);
		rects.push({
			key: placement.entry.key,
			page: placement.page,
			x: placement.x,
			y: placement.y,
			width: placement.entry.texture.width,
			height: placement.entry.texture.height,
		});
	}
	return { pages, rects, oversized, padding };
}
