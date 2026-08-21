/**
 * The entity registry and its marker colours, against hand-built assets.
 *
 * Two things are worth pinning. Which lang keys count as an entity type, because a variant label
 * (`entity.minecraft.villager.farmer`) is not one and shipping it as one puts entries in the pack that
 * no world's NBT will ever name. And which texture a mob resolves to, because the near-misses all
 * colour the marker as something else entirely — a llama the colour of its own spit, an armour stand
 * the colour of horse armour.
 */
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { vanillaJar } from './fixtures/index.ts';
import { collectEntities, entityTypesOf } from '../src/blocks/entities.ts';
import { MapResourceManager } from '../src/resources/synthetic.ts';
import { TextureLoader } from '../src/textures/loader.ts';
import { prepareVersionResources } from '../src/versions/prepare.ts';

import type { ResourceManager } from '../src/resources/manager.ts';

/** A 2x1 PNG: one fully opaque pixel of `rgb`, one fully transparent. */
function swatch(red: number, green: number, blue: number): Buffer {
	const crc = (buffer: Buffer): number => {
		let value = 0xFF_FF_FF_FF;
		for (const byte of buffer) {
			value ^= byte;
			for (let bit = 0; bit < 8; bit++) {
				value = (value >>> 1) ^ (0xED_B8_83_20 & -(value & 1));
			}
		}
		return (value ^ 0xFF_FF_FF_FF) >>> 0;
	};
	const chunk = (type: string, body: Buffer): Buffer => {
		const head = Buffer.alloc(8);
		head.writeUInt32BE(body.length, 0);
		head.write(type, 4, 'ascii');
		const tail = Buffer.alloc(4);
		tail.writeUInt32BE(crc(Buffer.concat([Buffer.from(type, 'ascii'), body])), 0);
		return Buffer.concat([head, body, tail]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(2, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8;
	header[9] = 6;
	// One scanline: filter byte, then two RGBA pixels
	const raw = Buffer.from([0, red, green, blue, 255, 0, 0, 0, 0]);
	return Buffer.concat([
		Buffer.from('89504e470d0a1a0a', 'hex'),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

interface Assets {
	lang?: Record<string, string>;
	/** Texture paths that exist, as `entity/cow/cow`, each with the colour to fill it. */
	textures?: Record<string, [number, number, number]>;
}

function resourcesFor(assets: Assets): ResourceManager {
	const manager = new MapResourceManager();
	if (assets.lang) {
		manager.set('lang', 'minecraft:en_us', JSON.stringify(assets.lang));
	}
	for (const [path, colour] of Object.entries(assets.textures ?? {})) {
		manager.set('texture', `minecraft:${path}`, swatch(...colour));
	}
	return manager;
}

async function collect(assets: Assets) {
	const resources = resourcesFor(assets);
	return await collectEntities({
		resources,
		textures: new TextureLoader(resources),
		namespaces: ['minecraft'],
	});
}

describe('entityTypesOf', () => {
	it('reads a type and its display name off the lang file', async () => {
		const types = await entityTypesOf(resourcesFor({
			lang: { 'entity.minecraft.cow': 'Cow', 'entity.minecraft.elder_guardian': 'Elder Guardian' },
		}), 'minecraft');

		expect(types).toStrictEqual([
			{ id: 'minecraft:cow', name: 'Cow' },
			{ id: 'minecraft:elder_guardian', name: 'Elder Guardian' },
		]);
	});

	/** A variant's own label is not a type, and no world's NBT will ever name one. */
	it('ignores a deeper key', async () => {
		const types = await entityTypesOf(resourcesFor({
			lang: {
				'entity.minecraft.villager': 'Villager',
				'entity.minecraft.villager.farmer': 'Farmer',
				'entity.minecraft.cat.type.siamese': 'Siamese',
			},
		}), 'minecraft');

		expect(types.map(type => type.id)).toStrictEqual(['minecraft:villager']);
	});

	it('ignores keys of other kinds, and other namespaces', async () => {
		const types = await entityTypesOf(resourcesFor({
			lang: { 'item.minecraft.lead': 'Lead', 'block.minecraft.stone': 'Stone', 'entity.somemod.thing': 'Thing' },
		}), 'minecraft');

		expect(types).toStrictEqual([]);
	});

	it('reads nothing from a namespace with no lang file, or an unparseable one', async () => {
		expect(await entityTypesOf(resourcesFor({}), 'minecraft')).toStrictEqual([]);
		const broken = new MapResourceManager().set('lang', 'minecraft:en_us', '{ not json');
		expect(await entityTypesOf(broken, 'minecraft')).toStrictEqual([]);
	});
});

describe('marker colours', () => {
	it('takes the mean of the opaque pixels of the mob sheet', async () => {
		const result = await collect({
			lang: { 'entity.minecraft.cow': 'Cow' },
			textures: { 'entity/cow/cow': [0x40, 0x80, 0xC0] },
		});

		// The transparent half of the swatch does not drag the mean toward black
		expect(result.entities['minecraft:cow']).toStrictEqual({
			name: 'Cow',
			texture: 'minecraft:entity/cow/cow',
			color: '#4080c0',
		});
	});

	/**
	 * A mob filed under a variant name rather than its own — a rabbit is `entity/rabbit/brown`, an elder
	 * guardian is `entity/guardian_elder`. Without the fallback these are the mobs with no colour.
	 */
	it('falls back to the best token overlap under entity/', async () => {
		const result = await collect({
			lang: { 'entity.minecraft.rabbit': 'Rabbit' },
			textures: { 'entity/rabbit/brown': [0x80, 0x60, 0x40] },
		});

		expect(result.entities['minecraft:rabbit'].texture).toBe('minecraft:entity/rabbit/brown');
		expect(result.entities['minecraft:rabbit'].color).toBe('#806040');
	});

	/**
	 * `entity/llama/spit` names the llama as well as its body sheet does and sits at the same depth, so
	 * the tie used to break arbitrarily and a llama came out the colour of spit.
	 */
	it('never takes a projectile or a piece of equipment for the mob', async () => {
		const result = await collect({
			lang: { 'entity.minecraft.llama': 'Llama' },
			textures: {
				'entity/llama/spit': [0xFF, 0xFF, 0xFF],
				'entity/llama/gray': [0x80, 0x80, 0x80],
			},
		});

		expect(result.entities['minecraft:llama'].texture).toBe('minecraft:entity/llama/gray');
	});

	/** A real vanilla convention: `entity/armorstand/`, `entity/slime/magmacube`. */
	it('matches a name with its underscores squashed out', async () => {
		const result = await collect({
			lang: { 'entity.minecraft.magma_cube': 'Magma Cube' },
			textures: { 'entity/slime/magmacube': [0xC0, 0x30, 0x10] },
		});

		expect(result.entities['minecraft:magma_cube'].texture).toBe('minecraft:entity/slime/magmacube');
	});

	/** Widening the search past `entity/` colours a marker off whatever block shares a word with it. */
	it('does not take a block texture for a mob', async () => {
		const result = await collect({
			lang: { 'entity.minecraft.cow': 'Cow' },
			textures: { 'block/cow_statue': [0xFF, 0x00, 0x00] },
		});

		expect(result.entities['minecraft:cow']).toStrictEqual({ name: 'Cow' });
	});

	/**
	 * An item entity, a falling block, a marker, a display, a thrown projectile: all real types with no
	 * sheet of their own, because they draw from an item or a block. No colour is invented for them.
	 */
	it('names an entity with no sheet, without a colour', async () => {
		const result = await collect({ lang: { 'entity.minecraft.item': 'Item' } });

		expect(result.entities['minecraft:item']).toStrictEqual({ name: 'Item' });
		expect(result.failures).toStrictEqual([
			{ id: 'minecraft:item', reason: 'no entity texture found; exported without a colour' },
		]);
	});

	it('keys entries by namespaced id, sorted', async () => {
		const result = await collect({
			lang: { 'entity.minecraft.zombie': 'Zombie', 'entity.minecraft.allay': 'Allay' },
		});

		expect(Object.keys(result.entities)).toStrictEqual(['minecraft:allay', 'minecraft:zombie']);
	});
});

describe('which sheet a mob is drawn with', () => {
	/**
	 * The sheet is not just a marker colour any more — it is what the geometry is *drawn on* — so picking
	 * the wrong one now shows. These are the three ways the search went wrong, each against the real
	 * 1.21.1 jar.
	 */
	const pick = async (id: string): Promise<string | undefined> => {
		const resources = await prepareVersionResources({ version: '1.21.1', jar: vanillaJar('1.21.1') });
		const collected = await collectEntities({
			resources,
			textures: new TextureLoader(resources),
			namespaces: ['minecraft'],
		});
		return collected.entities[id]?.texture;
	};

	/**
	 * A trader llama's *own* name is a file: `entity/llama/decor/trader_llama`, which is the carpet it
	 * wears. Taking it left the llama underneath invisible over most of its body, since a decor sheet is
	 * a few opaque pixels on transparency.
	 */
	it('takes the body sheet over an overlay named after the mob', { timeout: 300000 }, async () => {
		const texture = await pick('minecraft:trader_llama');

		expect(texture).toContain('entity/llama/');
		expect(texture).not.toContain('decor');
	});

	/**
	 * With the decor sheet out, `entity/wandering_trader` tied on token overlap and won on being one
	 * character shorter — putting a *human* trader's skin on a llama. A sheet inside the family's own
	 * folder outranks one that is not.
	 */
	it('prefers the family folder to a same-scoring outsider', { timeout: 300000 }, async () => {
		expect(await pick('minecraft:trader_llama')).not.toContain('wandering_trader');
		// And the chest boat still beats `entity/chest/`, which is a folder it merely shares a word with
		// (one type on 1.21.1; the per-wood split came in 1.21.2)
		expect(await pick('minecraft:chest_boat')).toContain('chest_boat');
	});

	/** Every sheet in `entity/horse/` is family, so the file naming the mob has to break that tie. */
	it('prefers the file that names the mob within a family', { timeout: 300000 }, async () => {
		const horse = await pick('minecraft:horse');

		expect(horse).toContain('entity/horse/horse');
		// The donkey and the mule are their own mobs and keep their own sheets
		expect(await pick('minecraft:donkey')).toBe('minecraft:entity/horse/donkey');
		expect(await pick('minecraft:mule')).toBe('minecraft:entity/horse/mule');
	});
});
