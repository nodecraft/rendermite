/**
 * Flat item sprites, for the items a world holds that are not blocks.
 *
 * A dropped stack is the commonest entity in a played-in world, and the game
 * draws it from the *item* model rather than the block one. Most of the time that
 * item model is a block's, and a consumer with the block pack already has what it
 * needs. The rest — a lead, a handful of charcoal, an arrow, a mod's seed — are
 * `item/generated`: a stack of flat sprites the client extrudes into a thin slab,
 * with no geometry stated anywhere because `ItemModelGenerator` builds it in code.
 *
 * So this exports the only thing there is to export: the ordered layer sprites,
 * and which of them the item tints. The consumer does the extruding.
 *
 * Deliberately *not* filtered to non-block ids. Whether an item is flat is decided
 * by asking what its own model resolves to, which is also what the game asks —
 * and it gets `minecraft:wheat` right, where the item is a flat sheaf and the
 * block of the same id is a crop cross.
 */

import { langRegistry, resolveItem } from '../items/discovery.ts';
import { resolveTexture } from '../models/loader.ts';
import { resolveTints } from '../render/tints.ts';

import type { ItemPackEntry, ItemPackLayer } from './pack-format.ts';
import type { ModelLoader } from '../models/loader.ts';
import type { ResourceManager } from '../resources/manager.ts';
import type { TextureLoader } from '../textures/loader.ts';

/** The builtin parent whose geometry the client generates from flat layers. */
const GENERATED = 'builtin/generated';

/** `layer0`, `layer1`, … in the order the client stacks them. */
const LAYER_NAME = /^layer(\d+)$/;

export interface ItemSpriteFailure {
	id: string;
	reason: string;
}

export interface ItemSpriteResult {
	/** Flat items only, by item id; anything absent is the consumer's block-model job. */
	items: Record<string, ItemPackEntry>;
	/** Sprite ids to pack, which is every layer of every entry. */
	spriteIds: Set<string>;
	failures: ItemSpriteFailure[];
}

/** `{ r, g, b }` in 0–1 as `#rrggbb`, matching how the tint pack writes a colour. */
function hex(color: { r: number; g: number; b: number; }): string {
	return `#${[color.r, color.g, color.b]
		.map(channel => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, '0'))
		.join('')}`;
}

/**
 * The layers of one generated model, in draw order.
 *
 * Sorted by the number in the name rather than by key order: a mod that writes
 * `layer1` before `layer0` still stacks the way the client stacks it, and a chain
 * that merged its parent's textures has no reliable order at all.
 */
function layersOf(textures: Record<string, string>): Array<{ index: number; reference: string; }> {
	const layers: Array<{ index: number; reference: string; }> = [];
	for (const name of Object.keys(textures)) {
		const match = LAYER_NAME.exec(name);
		if (match) {
			layers.push({ index: Number(match[1]), reference: `#${name}` });
		}
	}
	return layers.toSorted((left, right) => left.index - right.index);
}

export interface CollectItemSpritesOptions {
	resources: ResourceManager;
	models: ModelLoader;
	textures: TextureLoader;
	namespaces: readonly string[];
	/**
	 * Ids the pack describes as blocks. Only used to decide whether a non-flat item
	 * is worth reporting: a stone block item drawing from `blockstates.json` is the
	 * design, while one nothing describes is a gap somebody should hear about.
	 */
	blocks: ReadonlySet<string>;
	/** Item ids to consider, as `discoverItems` yields them. */
	itemIds: readonly string[];
	onProgress?: (done: number, total: number) => void;
}

export async function collectItemSprites(options: CollectItemSpritesOptions): Promise<ItemSpriteResult> {
	const { resources, models, textures, blocks, itemIds } = options;
	const items: Record<string, ItemPackEntry> = {};
	const spriteIds = new Set<string>();
	const failures: ItemSpriteFailure[] = [];
	let done = 0;

	/*
	 * Item discovery scans `models/item/` as well as the registry, so it hands back
	 * template and aux models alongside real items — `minecraft:generated`,
	 * `handheld_rod`, `spyglass_in_hand`. Those are not items, never appear in a
	 * world's NBT, and a pack with no entry for one is not a gap anybody should hear
	 * about. A translation key is the closest thing a jar carries to the item
	 * registry, so it is what decides whether silence is worth breaking.
	 */
	const translated = new Map<string, Set<string> | null>();
	for (const namespace of options.namespaces) {
		translated.set(namespace, await langRegistry(resources, namespace));
	}
	const report = (id: string, reason: string): void => {
		const divider = id.indexOf(':');
		const gate = translated.get(id.slice(0, divider));
		// No lang file to gate on (a 1.7.10-era mod): say it rather than swallow it
		if (gate === undefined || gate === null || gate.has(id.slice(divider + 1).replaceAll('/', '.'))) {
			failures.push({ id, reason });
		}
	};

	for (const id of [...itemIds].toSorted((left, right) => left.localeCompare(right))) {
		options.onProgress?.(++done, itemIds.length);
		let instructions;
		try {
			instructions = await resolveItem(resources, id);
		} catch (err) {
			// Only worth saying when the block pack cannot draw it either
			if (!blocks.has(id)) {
				report(id, (err as Error).message);
			}
			continue;
		}

		const layers: ItemPackLayer[] = [];
		let flat = true;
		for (const instruction of instructions) {
			let model;
			try {
				model = await models.load(instruction.model);
			} catch (err) {
				flat = false;
				if (!blocks.has(id)) {
					report(id, `model ${instruction.model} did not load: ${(err as Error).message}`);
				}
				break;
			}
			if (model.builtinParent !== GENERATED) {
				// A real model: either a block's, or a 3D item like a trident or a bow.
				// Both are the consumer's problem to draw, and only the second is a gap.
				flat = false;
				break;
			}
			const tints = await resolveTints(instruction.tints, { textures });
			for (const layer of layersOf(model.textures)) {
				const sprite = resolveTexture(model, layer.reference);
				if (!sprite) {
					// A generated model naming a variable nothing binds draws nothing at all
					// in the game either; dropping the layer keeps the rest of the stack.
					report(id, `${layer.reference} resolves to no texture; layer dropped`);
					continue;
				}
				const tint = tints[layer.index];
				layers.push({
					sprite: sprite.toString(),
					// The client passes each layer its own index as the tint index, so a layer
					// is tinted exactly when the definition declares one at that position
					...(instruction.tints[layer.index] !== undefined && { tintindex: layer.index }),
					...(tint && { tint: hex(tint) }),
				});
				spriteIds.add(sprite.toString());
			}
		}

		if (!flat) {
			if (!blocks.has(id)) {
				report(id, 'item model is not a flat sprite stack and the pack describes no block of this id');
			}
			continue;
		}
		if (layers.length === 0) {
			// `item/generated` with no layers at all: nothing the game could draw either
			report(id, 'generated item model states no layers');
			continue;
		}
		items[id] = { layers };
	}

	return { items, spriteIds, failures };
}
