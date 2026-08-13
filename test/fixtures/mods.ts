/**
 * Synthetic mod jars, built from these committed declarations into
 * `.work/fixtures/mods/*.jar`. Together they exercise the mod code paths the
 * real-world failure taxonomy identified, without shipping anyone else's
 * copyrighted assets: cross-jar dependencies, custom loader models (composite,
 * separate_transforms, fluid containers, OBJ, childModel), Gson-tolerated junk
 * JSON, 1.21.4+ item definitions with tints, and 1.7.10-era texture-only
 * namespaces (plural dirs, camelCase names, cube/face-suffix synthesis rules).
 */

import { existsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import sharp from 'sharp';
import { ZipFile } from 'yazl';

import { fixturesDir } from './index.ts';

type JarEntries = Record<string, unknown | string | { color: [number, number, number, number]; size?: number; }>;

interface FixtureMod {
	name: string;
	entries: JarEntries;
}

const png = (color: [number, number, number, number], size = 4) => {
	return { color, size };
};

const MODS: FixtureMod[] = [
	{
		// Dependency target: provides a block model and textures other jars use.
		name: 'depcore',
		entries: {
			'assets/depcore/models/block/machine_frame.json': { parent: 'block/cube_all', textures: { all: 'depcore:block/frame' } },
			'assets/depcore/models/item/machine_frame.json': { parent: 'depcore:block/machine_frame' },
			'assets/depcore/textures/block/frame.png': png([120, 120, 140, 255]),
			'assets/depcore/textures/item/core_gear.png': png([200, 170, 60, 255]),
			// Mods also add textures to the vanilla namespace; half the old
			// pipeline's missing-texture failures were paths a jar already held.
			'assets/minecraft/textures/block/depcore_extra.png': png([10, 200, 10, 255]),
			// Mod trim overlays via a minecraft-namespace atlas file that must
			// MERGE with vanilla's blocks.json, not shadow it (create's cardboard
			// armor pattern).
			'assets/minecraft/atlases/blocks.json': {
				sources: [{
					type: 'paletted_permutations',
					textures: ['depcore:trims/items/gear_trim'],
					palette_key: 'minecraft:trims/color_palettes/trim_palette',
					permutations: { amethyst: 'minecraft:trims/color_palettes/amethyst' },
				}],
			},
			'assets/depcore/textures/trims/items/gear_trim.png': png([160, 160, 160, 255], 8),
			'assets/depcore/models/item/trimmed_gear.json': {
				parent: 'item/generated',
				textures: { layer0: 'depcore:item/core_gear', layer1: 'depcore:trims/items/gear_trim_amethyst' },
			},
		},
	},
	{
		// Depends on depcore for a model parent AND a texture.
		name: 'depaddon',
		entries: {
			'assets/depaddon/models/item/machine.json': { parent: 'depcore:block/machine_frame' },
			'assets/depaddon/models/item/gadget.json': { parent: 'item/generated', textures: { layer0: 'depcore:item/core_gear' } },
			'assets/depaddon/models/item/extra_user.json': { parent: 'block/cube_all', textures: { all: 'minecraft:block/depcore_extra' } },
		},
	},
	{
		// Every loader-model flattening branch.
		name: 'loadermod',
		entries: {
			'assets/loadermod/models/item/composite_item.json': {
				loader: 'forge:composite',
				children: { main: { parent: 'item/generated', textures: { layer0: 'loadermod:item/widget' } } },
			},
			'assets/loadermod/models/item/transforms_item.json': {
				loader: 'neoforge:separate_transforms',
				base: { parent: 'item/generated', textures: { layer0: 'loadermod:item/widget' } },
				perspectives: { gui: { parent: 'item/generated', textures: { layer0: 'loadermod:item/gui_widget' } } },
			},
			'assets/loadermod/models/item/child_item.json': {
				loader: 'somemod:custom_thing',
				childModel: 'loadermod:item/real_widget',
			},
			'assets/loadermod/models/item/real_widget.json': { parent: 'item/generated', textures: { layer0: 'loadermod:item/widget' } },
			'assets/loadermod/models/item/tank_item.json': { loader: 'somemod:fluid_container' },
			// fluid_container with a resolvable fluid: the bucket gets its
			// contents painted from the fluid's conventional still texture.
			'assets/loadermod/models/item/goop_bucket.json': {
				parent: 'forge:item/bucket',
				loader: 'forge:fluid_container',
				fluid: 'loadermod:goop',
			},
			'assets/loadermod/textures/block/fluid/goop_still.png': png([30, 220, 60, 255], 16),
			'assets/loadermod/models/item/obj_item.json': {
				loader: 'forge:obj',
				model: 'loadermod:models/item/thing.obj',
				flip_v: true,
				textures: { thing_skin: 'loadermod:item/widget' },
				display: { gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] } },
			},
			// A unit cube with a slanted top, textured via the model's texture map.
			'assets/loadermod/models/item/thing.obj': [
				'mtllib thing.mtl',
				'v 0 0 0',
				'v 1 0 0',
				'v 1 0 1',
				'v 0 0 1',
				'v 0 0.75 0',
				'v 1 0.5 0',
				'v 1 0.5 1',
				'v 0 0.75 1',
				'vt 0 0',
				'vt 1 0',
				'vt 1 1',
				'vt 0 1',
				'usemtl thing_material',
				'f 1/1 2/2 6/3 5/4',
				'f 3/1 4/2 8/3 7/4',
				'f 2/1 3/2 7/3 6/4',
				'f 4/1 1/2 5/3 8/4',
				'f 5/1 6/2 7/3 8/4',
				'f 4/1 3/2 2/3 1/4',
			].join('\n'),
			'assets/loadermod/models/item/thing.mtl': [
				'newmtl thing_material',
				'map_Kd #thing_skin',
			].join('\n'),
			// OBJ referencing a missing file must still fail loudly.
			'assets/loadermod/models/item/broken_obj_item.json': { loader: 'forge:obj', model: 'loadermod:models/item/missing.obj' },
			// Winding regression: a red top face and green bottom face, standard
			// CCW-front. Inside-out rendering (the lightning_rod bug) culls the
			// top and shows green instead.
			'assets/loadermod/models/item/winding_obj_item.json': {
				loader: 'forge:obj',
				model: 'loadermod:models/item/winding.obj',
				display: { gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] } },
			},
			'assets/loadermod/models/item/winding.obj': [
				'mtllib winding.mtl',
				'v 0 0 0',
				'v 1 0 0',
				'v 1 0 1',
				'v 0 0 1',
				'v 0 1 0',
				'v 1 1 0',
				'v 1 1 1',
				'v 0 1 1',
				'vt 0 0',
				'vt 1 0',
				'vt 1 1',
				'vt 0 1',
				'usemtl top_material',
				'f 5/1 8/2 7/3 6/4',
				'usemtl bottom_material',
				'f 1/1 2/2 3/3 4/4',
			].join('\n'),
			'assets/loadermod/models/item/winding.mtl': [
				'newmtl top_material',
				'map_Kd loadermod:item/red_face',
				'newmtl bottom_material',
				'map_Kd loadermod:item/green_face',
			].join('\n'),
			'assets/loadermod/textures/item/red_face.png': png([220, 30, 30, 255]),
			'assets/loadermod/textures/item/green_face.png': png([30, 220, 30, 255]),
			// IE-style: composite children are themselves loader models (OBJ) —
			// flattening must recurse instead of stripping the child's loader.
			'assets/loadermod/models/item/nested_obj_item.json': {
				loader: 'forge:composite',
				children: {
					solid: {
						loader: 'forge:obj',
						model: 'loadermod:models/item/thing.obj',
						flip_v: true,
						textures: { thing_skin: 'loadermod:item/widget' },
					},
				},
			},
			// IE-style split multiblock: drawable model wrapped as inner_model.
			'assets/loadermod/models/item/split_item.json': {
				loader: 'somemod:basic_split',
				inner_model: { parent: 'item/generated', textures: { layer0: 'loadermod:item/widget' } },
				split_parts: [[0, 0, 0]],
			},
			// IE conveyor loader: geometry lives in Java; a flat belt is synthesized.
			'assets/loadermod/models/item/belt_item.json': {
				loader: 'immersiveengineering:models/conveyor',
				conveyorType: 'loadermod:basic',
			},
			'assets/loadermod/textures/block/conveyor/conveyor.png': png([50, 50, 60, 255], 16),
			// IE conf_sides: per-face textures derived from base_name at runtime.
			'assets/loadermod/models/item/conf_item.json': {
				loader: 'immersiveengineering:conf_sides',
				type: 'side_top_bottom',
				base_name: 'loadermod:block/conf',
			},
			'assets/loadermod/textures/block/conf_side_none.png': png([100, 100, 200, 255]),
			'assets/loadermod/textures/block/conf_up_none.png': png([200, 100, 100, 255]),
			'assets/loadermod/textures/block/conf_down_none.png': png([100, 200, 100, 255]),
			// Element face bound to a literally-unresolvable variable (spectrum's
			// "#missing") — the face skips, the rest of the cube still renders.
			'assets/loadermod/models/item/partial_faces_item.json': {
				textures: { good: 'loadermod:item/widget' },
				elements: [{
					from: [0, 0, 0],
					to: [16, 16, 16],
					faces: {
						up: { texture: '#missing' },
						north: { texture: '#good' },
						south: { texture: '#good' },
						east: { texture: '#good' },
						west: { texture: '#good' },
						down: { texture: '#good' },
					},
				}],
				display: { gui: { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] } },
			},
			// Item model is pure code, but a same-name block model is drawable —
			// the game shows the block, so should we.
			'assets/loadermod/models/item/machine_thing.json': { loader: 'somemod:dynamic' },
			'assets/loadermod/models/block/machine_thing.json': { parent: 'block/cube_all', textures: { all: 'loadermod:item/widget' } },
			// Dyed variant of a vanilla item whose model only exists at runtime.
			'assets/loadermod/models/item/red_frame_empty.json': { parent: 'loadermod:block/red_frame' },
			// Template model: parented by another item model, no layers of its
			// own — a skipped template, not a failure.
			'assets/loadermod/models/item/oversized_template.json': { parent: 'item/generated' },
			'assets/loadermod/models/item/uses_template.json': { parent: 'loadermod:item/oversized_template', textures: { layer0: 'loadermod:item/widget' } },
			// Trailing junk after the closing brace — Gson tolerates, JSON.parse dies.
			'assets/loadermod/models/item/junk_item.json': `${JSON.stringify({ parent: 'item/generated', textures: { layer0: 'loadermod:item/widget' } })}\n}}garbage`,
			'assets/loadermod/textures/item/widget.png': png([40, 90, 220, 255]),
			'assets/loadermod/textures/item/gui_widget.png': png([220, 40, 40, 255]),
			// State/aux model with no translation key — never a real item.
			'assets/loadermod/models/item/obj_item_pulling_0.json': { parent: 'item/generated', textures: { layer0: 'loadermod:item/widget' } },
			// Trim variant models are key-less too but stay first-class icons.
			'assets/loadermod/models/item/machine_thing_copper_trim.json': { parent: 'item/generated', textures: { layer0: 'loadermod:item/widget' } },
			// Lang keys stand in for the item registry: model-derived ids missing
			// from here are dropped at discovery (except _trim variants).
			'assets/loadermod/lang/en_us.json': Object.fromEntries(
				[
					'composite_item',
					'transforms_item',
					'child_item',
					'tank_item',
					'goop_bucket',
					'obj_item',
					'broken_obj_item',
					'nested_obj_item',
					'split_item',
					'conf_item',
					'partial_faces_item',
					'machine_thing',
					'red_frame_empty',
					'uses_template',
					'belt_item',
					'winding_obj_item',
					'junk_item',
				].map(name => [`item.loadermod.${name}`, name]),
			),
		},
	},
	{
		// 1.21.4+ items/ definitions incl. tint plumbing.
		name: 'modernmod',
		entries: {
			'assets/modernmod/items/gizmo.json': {
				model: {
					type: 'minecraft:model',
					model: 'modernmod:item/gizmo',
					// ARGB above 2^31 — signed-shift corruption regression guard.
					tints: [{ type: 'minecraft:constant', value: 4_294_901_760 }],
				},
			},
			'assets/modernmod/items/selector.json': {
				model: {
					type: 'minecraft:select',
					property: 'minecraft:display_context',
					cases: [{ when: 'gui', model: { type: 'minecraft:model', model: 'modernmod:item/gizmo' } }],
					fallback: { type: 'minecraft:empty' },
				},
			},
			'assets/modernmod/items/grassy.json': {
				model: {
					type: 'minecraft:model',
					model: 'modernmod:item/gizmo',
					tints: [{ type: 'minecraft:grass', temperature: 0.8, downfall: 0.4 }],
				},
			},
			'assets/modernmod/items/special_thing.json': {
				model: { type: 'minecraft:special', base: 'modernmod:item/gizmo', model: { type: 'somemod:widget_renderer' } },
			},
			'assets/modernmod/items/empty_thing.json': { model: { type: 'minecraft:empty' } },
			'assets/modernmod/models/item/gizmo.json': { parent: 'item/generated', textures: { layer0: 'modernmod:item/gizmo' } },
			// Grayscale so tint colors dominate the dominant-color assertions.
			'assets/modernmod/textures/item/gizmo.png': png([200, 200, 200, 255], 8),
		},
	},
	{
		// GeckoLib-style: item models are code-rendered stubs, real geometry
		// lives in Bedrock .geo.json files, textures follow item-name convention.
		name: 'geckomod',
		entries: {
			// Code-rendered marker: chains to builtin/entity like vanilla specials.
			'assets/geckomod/models/item/beast.json': { parent: 'builtin/entity' },
			'assets/geckomod/geo/beast.geo.json': {
				'format_version': '1.12.0',
				'minecraft:geometry': [{
					description: { identifier: 'geometry.beast', texture_width: 32, texture_height: 32 },
					bones: [
						{
							name: 'body',
							pivot: [0, 0, 0],
							cubes: [{ origin: [-4, 0, -4], size: [8, 8, 8], uv: [0, 0] }],
						},
						{
							name: 'head',
							parent: 'body',
							pivot: [0, 8, 0],
							rotation: [0, 25, 0],
							cubes: [{ origin: [-3, 8, -3], size: [6, 6, 6], uv: [0, 16], inflate: 0.25 }],
						},
					],
				}],
			},
			'assets/geckomod/textures/item/beast.png': png([90, 160, 60, 255], 32),
			// Spawn egg: colors live in code, so tints derive from the mob's
			// entity texture (green) instead of rendering a white egg.
			'assets/geckomod/models/item/beast_spawn_egg.json': { parent: 'minecraft:item/template_spawn_egg' },
			'assets/geckomod/textures/entity/beast.png': png([60, 190, 60, 255], 32),
			// Oritech-style: geo nested under geo/block/models with the texture
			// mirroring the path under textures/ — found by scan, not convention.
			'assets/geckomod/models/item/nested_machine.json': { parent: 'builtin/entity' },
			'assets/geckomod/geo/block/models/nested_machine.geo.json': {
				'format_version': '1.12.0',
				'minecraft:geometry': [{
					description: { identifier: 'geometry.nested_machine', texture_width: 16, texture_height: 16 },
					bones: [{ name: 'body', pivot: [0, 0, 0], cubes: [{ origin: [-4, 0, -4], size: [8, 8, 8], uv: [0, 0] }] }],
				}],
			},
			'assets/geckomod/textures/block/models/nested_machine.png': png([200, 120, 30, 255], 16),
			// Code-rendered with a flat sprite only → sprite fallback.
			'assets/geckomod/models/item/statue.json': { parent: 'builtin/entity' },
			'assets/geckomod/textures/item/statue.png': png([160, 60, 160, 255], 8),
			// Code-rendered with nothing to fall back on → loud failure.
			'assets/geckomod/models/item/hopeless.json': { parent: 'builtin/entity' },
			// Code-rendered chest with the mod's own entity texture (64x64 sheet).
			'assets/geckomod/models/item/ruby_chest.json': { parent: 'builtin/entity' },
			'assets/geckomod/textures/entity/ruby_chest.png': png([200, 40, 40, 255], 64),
			// Quark-style per-wood chest sheets in variant directories: the wood
			// and trapped-ness live in the PATH, not the filename.
			'assets/geckomod/models/item/maple_chest.json': { parent: 'builtin/entity' },
			'assets/geckomod/models/item/maple_trapped_chest.json': { parent: 'builtin/entity' },
			'assets/geckomod/textures/mod_chests/maple/normal.png': png([40, 180, 40, 255], 64),
			'assets/geckomod/textures/mod_chests/maple/trap.png': png([40, 40, 200, 255], 64),
			// Decoy chest-boat sheet with the same wood token — must never win
			// over the real chest sheet (quark's blossom_chest regression).
			'assets/geckomod/textures/model/entity/chest_boat/maple.png': png([200, 40, 200, 255], 64),
			// Vanilla-mob head item name → builtin mobheads geometry + vanilla skin.
			'assets/geckomod/models/item/creeper_head.json': { parent: 'builtin/entity' },
			// Variant mob head: trailing tokens shed until a builtin mob matches.
			'assets/geckomod/models/item/parrot_blue_head.json': { parent: 'builtin/entity' },
			// Template model in a lang-less jar: caught by the parent-reference
			// classifier since discovery has no registry to gate on.
			'assets/geckomod/models/item/gecko_template.json': { parent: 'item/generated' },
			'assets/geckomod/models/item/uses_gecko_template.json': { parent: 'geckomod:item/gecko_template', textures: { layer0: 'geckomod:item/statue' } },
		},
	},
	{
		// Modern code-rendered bed whose entity sheet is supplied by the mod.
		name: 'modernentitymod',
		entries: {
			'assets/modernentitymod/models/item/azure_bed.json': { parent: 'builtin/entity' },
			'assets/modernentitymod/textures/entity/bed/azure.png': png([30, 90, 220, 255], 64),
			'assets/modernentitymod/models/item/azure_crate.json': { parent: 'minecraft:item/template_chest' },
			'assets/modernentitymod/textures/entity/azure_crate/single/azure_crate_0.png': png([30, 90, 220, 255], 64),
			'assets/modernentitymod/lang/en_us.json': {
				'item.modernentitymod.azure_bed': 'Azure Bed',
				'item.modernentitymod.azure_crate': 'Azure Crate',
			},
		},
	},
	{
		// 1.7.10-era: no JSON models at all; plural texture dirs; camelCase names.
		name: 'legacymod',
		entries: {
			'assets/legacymod/textures/items/CamelTool.png': png([230, 120, 30, 255]),
			'assets/legacymod/textures/items/plain_item.png': png([30, 120, 230, 255]),
			'assets/legacymod/textures/blocks/ore_thing.png': png([90, 200, 90, 255]),
			// cube_bottom_top synthesis: base + _top + _side.
			'assets/legacymod/textures/blocks/machine.png': png([120, 120, 120, 255]),
			'assets/legacymod/textures/blocks/machine_top.png': png([180, 60, 60, 255]),
			'assets/legacymod/textures/blocks/machine_side.png': png([60, 60, 180, 255]),
			// Face-suffix-only texture must NOT become an item.
			'assets/legacymod/textures/blocks/frame_overlay.png': png([255, 0, 255, 255]),
		},
	},
];

async function encodeEntry(value: JarEntries[string]): Promise<Buffer> {
	if (typeof value === 'string') {
		return Buffer.from(value, 'utf8');
	}
	if (value && typeof value === 'object' && 'color' in (value as Record<string, unknown>)) {
		const { color, size = 4 } = value as { color: [number, number, number, number]; size?: number; };
		return sharp({
			create: {
				width: size,
				height: size,
				channels: 4,
				background: { r: color[0], g: color[1], b: color[2], alpha: color[3] / 255 },
			},
		}).png().toBuffer();
	}
	return Buffer.from(JSON.stringify(value, null, '\t'), 'utf8');
}

export const fixtureModJar = (name: string): string => path.join(fixturesDir, 'mods', `${name}.jar`);

/** Build all fixture mod jars that are not already cached. */
export async function buildFixtureModJars(): Promise<void> {
	await mkdir(path.join(fixturesDir, 'mods'), { recursive: true });
	for (const mod of MODS) {
		const jarPath = fixtureModJar(mod.name);
		if (existsSync(jarPath)) {
			continue;
		}
		const zip = new ZipFile();
		for (const [entryPath, value] of Object.entries(mod.entries)) {
			zip.addBuffer(await encodeEntry(value), entryPath);
		}
		zip.end();
		await new Promise<void>((resolve, reject) => {
			const stream = zip.outputStream.pipe(createWriteStream(jarPath));
			stream.on('close', () => resolve());
			stream.on('error', reject);
		});
	}
}
