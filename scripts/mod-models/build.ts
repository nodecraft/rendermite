/**
 * Regenerates assets/mod-models from the mods' own entity-model classes:
 *
 *   node scripts/mod-models/build.ts
 *
 * Geometry is read out of the bytecode (see extract.ts) so no box or UV number
 * is hand-copied. What cannot be read mechanically — the ISTER pose, which
 * parts draw emissive or translucent, and the texture — is the spec below, each
 * entry citing the class it came from. Requires `javap` (any JDK) and the mod
 * jars under .work/fixtures/modrinth/, which the test fixtures download.
 */
import path from 'node:path';

import { buildModel } from './generate.ts';

import type { ItemSpec, Repeat } from './generate.ts';
import type { PoseOp } from './pose.ts';

const fixtures = path.join(import.meta.dirname, '..', '..', '.work', 'fixtures', 'modrinth');
const MEKANISM = path.join(fixtures, 'mekanism-neoforge-1.21.1.jar');
const BOTANIA = path.join(fixtures, 'botania-forge-1.20.1.jar');

/**
 * PylonBlockEntityRenderer takes 1.35 rather than 1.5 when the block entity is
 * null, which is exactly the item path. Its ring and crystal also spin, by
 * ticksInGame plus a per-block-position random offset — an item has no position,
 * so there is no "correct" angle; frame 0 with no spin is the chosen still, and
 * at that frame the ring's and crystal's poses coincide.
 */
const PYLON_POSE: PoseOp[] = [
	{ translate: [0, 1.35, 0] },
	{ scale: [1, -1, -1] },
	{ translate: [0.5, 0, -0.5] },
];

/**
 * BotanicalBreweryModel draws its `plate` once per ingredient slot — seven with
 * no block entity — sweeping it round by assigning ModelPart.yRot in steps of
 * 2π/7 while nudging each one vertically by sin(time/20 + i*40)*0.2 - 0.2. The
 * vertical term is non-zero even at frame 0, so the plates sit at staggered
 * heights exactly as they do in game on that tick.
 */
const BREWERY_PLATES: Repeat[] = Array.from({ length: 7 }, (_, index) => {
	return {
		yRot: index * 360 / 7,
		pose: [{ translate: [0, Math.sin(index * 40) * 0.2 - 0.2, 0] }],
	};
});

/**
 * CorporeaIndexBlockEntityRenderer tilts each ring by 60° about the XZ diagonal:
 * `Quaternionf.rotateAxis(toRadians(60), ANGLE, 0, ANGLE)` with
 * `ANGLE = sin(45°)`, so the axis is already unit length.
 */
const CORPOREA_TILT: PoseOp = { rotateAxis: [Math.sin(Math.PI / 4), 0, Math.sin(Math.PI / 4)], degrees: 60 };

/**
 * The renderer nests ring, ring, cube, each step adding scale(0.875), the tilt
 * and a rotateY driven by (ticksInGame + partialTicks) * 2 — zero at frame 0, so
 * only the tilts and scales survive. It special-cases the item path with
 * scale(1.3) and translate(0, -0.1, 0) when the block entity is null.
 */
const CORPOREA_BASE: PoseOp[] = [
	{ translate: [0.5, 0, 0.5] },
	{ scale: [1.3, 1.3, 1.3] },
	{ translate: [0, -0.1, 0] },
	{ translate: [0, -1, 0] },
	{ translate: [0, 1.5, 0] },
];
const CORPOREA_RING_2: PoseOp[] = [CORPOREA_TILT, { scale: [0.875, 0.875, 0.875] }, CORPOREA_TILT];

/**
 * Botania 1.20.1. Its items have no ISTER of their own: TEISR hands the stack
 * straight to the block's BlockEntityRenderer with a dummy block entity, so each
 * pose below is that renderer's in-world pose — the standard
 * translate(0.5, ~1.5, 0.5) + scale(1, -1, -1) block-entity flip. Sheet sizes
 * come from BotaniaLayerDefinitions, not the model classes.
 */
const BOTANIA_SPECS: ItemSpec[] = [
	{
		id: 'botania:avatar',
		jar: BOTANIA,
		modelClass: 'client/model/AvatarModel.class',
		texture: 'botania:model/avatar',
		sheet: [32, 32],
		// AvatarBlockEntityRenderer: with a dummy BE getLevel() is null, so facing
		// falls back to SOUTH and ROTATIONS[max(0, min(3, 0 - 2))] = ROTATIONS[0].
		pose: [
			{ translate: [0.5, 1.6, 0.5] },
			{ scale: [1, -1, -1] },
			{ rotate: 'y', degrees: 180 },
		],
	},
	{
		id: 'botania:bellows',
		jar: BOTANIA,
		modelClass: 'client/model/BellowsModel.class',
		texture: 'botania:model/bellows',
		sheet: [64, 32],
		// A dummy BE leaves the facing rotation at 0.
		pose: [
			{ translate: [0.5, 1.5, 0.5] },
			{ scale: [1, -1, -1] },
		],
		// BellowsModel.render poses the funnel apart from the rest. Its squeeze
		// fraction is max(0.1, 1 - 0) = 1 with a dummy BE, so the top does not move
		// and the funnel's scale term is 1.
		partPoses: {
			funnel: [
				{ rotate: 'x', degrees: 180 },
				{ translate: [-0.19, -1.375, -0.19] },
			],
		},
	},
	{
		id: 'botania:teru_teru_bozu',
		jar: BOTANIA,
		modelClass: 'client/model/TeruTeruBozuModel.class',
		texture: 'botania:model/teru_teru_bozu',
		sheet: [64, 32],
		// It bobs and spins on ticksInGame; frame 0 zeroes the sin terms, the Y
		// spin and the Z sway, leaving just the flip, the offset and the scale.
		pose: [
			{ rotate: 'x', degrees: 180 },
			{ translate: [0.5, -1.25, -0.5] },
			{ scale: [0.75, 0.75, 0.75] },
		],
		// The two faces are alternatives: the happy one is for rain.
		skip: ['happy_face'],
	},
	{
		id: 'botania:brewery',
		jar: BOTANIA,
		modelClass: 'client/model/BotanicalBreweryModel.class',
		texture: 'botania:model/brewery',
		sheet: [32, 16],
		// The renderer scales before translating; the model then lifts everything by
		// its own sin(time/40)*0.1 + 0.05 bob, which is 0.05 at frame 0.
		pose: [
			{ scale: [1, -1, -1] },
			{ translate: [0.5, -1.5, -0.5] },
			{ translate: [0, 0.05, 0] },
		],
		repeat: { plate: BREWERY_PLATES },
	},
	{
		id: 'botania:hourglass',
		jar: BOTANIA,
		modelClass: 'client/model/HourglassModel.class',
		texture: 'botania:model/hourglass',
		sheet: [64, 32],
		// HoveringHourglassBlockEntityRenderer zeroes its own clock when there is no
		// world, so this is the frame the game itself draws for the item, not a
		// chosen still: cos(0) and sin(0) fix the hover at (0.525, 0.6, 0.5), and the
		// flip term resolves to Botania's own 1° rather than 180°.
		pose: [
			{ translate: [0.525, 0.6, 0.5] },
			{ rotate: 'z', degrees: 1 },
			{ scale: [1, -1, -1] },
		],
		// The sand tracks the contents, which an item stack has none of — the
		// renderer scales it to nothing.
		skip: ['sand_top', 'sand_bottom'],
	},
	{
		id: 'botania:corporea_index',
		jar: BOTANIA,
		// Its geometry lives in the renderer, not a model class.
		modelClass: 'block_entity/CorporeaIndexBlockEntityRenderer.class',
		texture: 'botania:model/corporea_index',
		sheet: [64, 32],
		pose: CORPOREA_BASE,
		// The ring is drawn twice, the second nested inside the first.
		repeat: { ring: [{ pose: [CORPOREA_TILT] }, { pose: CORPOREA_RING_2 }] },
		partPoses: {
			cube: [...CORPOREA_RING_2, { scale: [0.875, 0.875, 0.875] }, CORPOREA_TILT],
		},
	},
	{
		id: 'botania:mana_pylon',
		jar: BOTANIA,
		modelClass: 'client/model/ManaPylonModel.class',
		texture: 'botania:model/pylon_mana',
		sheet: [64, 64],
		pose: PYLON_POSE,
		// renderCrystal draws these through a *_PYLON_GLOW render type, which is
		// fullbright; the ring goes through the plain entity type.
		groups: [
			{ parts: ['shardlf', 'shardrf', 'shardlb', 'shardrb'], emissive: true },
			{},
		],
	},
	{
		id: 'botania:natura_pylon',
		jar: BOTANIA,
		modelClass: 'client/model/NaturaPylonModel.class',
		texture: 'botania:model/pylon_natura',
		sheet: [64, 64],
		pose: PYLON_POSE,
		// renderCrystal draws these through a *_PYLON_GLOW render type, which is
		// fullbright; the ring goes through the plain entity type.
		groups: [
			{ parts: [
				'shardrft',
				'shardlbt',
				'shardrbt',
				'shardlft',
				'shardrfb',
				'shardlbb',
				'shardrbb',
				'shardlfb',
			],
			emissive: true },
			{},
		],
	},
	{
		id: 'botania:gaia_pylon',
		jar: BOTANIA,
		modelClass: 'client/model/GaiaPylonModel.class',
		texture: 'botania:model/pylon_gaia',
		sheet: [64, 64],
		pose: PYLON_POSE,
		// renderCrystal draws these through a *_PYLON_GLOW render type, which is
		// fullbright; the ring goes through the plain entity type.
		groups: [
			{ parts: [
				'shardrft',
				'shardlbt',
				'shardrbt',
				'shardlft',
				'shardrfb',
				'shardlbb',
				'shardrbb',
				'shardlfb',
			],
			emissive: true },
			{},
		],
	},
];

/**
 * Mekanism 10.7.19 (1.21.1, NeoForge). Every one of these is a MekanismISTER
 * posing the model with translate(0.5, 0.5, 0.5) then Axis.ZP 180°, which is
 * generate.ts's default bake; only free_runners adds a further translate.
 * Emissive/translucent groups come from each model's render() +
 * renderToBuffer(): `litParts` draw at light 15728880, and the glass-like
 * groups additionally carry an alpha in their vertex colour.
 */
const SPECS: ItemSpec[] = [
	{
		id: 'mekanism:atomic_disassembler',
		jar: MEKANISM,
		modelClass: 'model/ModelAtomicDisassembler.class',
		texture: 'mekanism:render/atomic_disassembler',
		// bladeParts: MekanismRenderType.BLADE, light 15728880, colour 0xBFFFFFFF.
		groups: [
			{
				parts: ['bladeBack', 'bladeBackSmall', 'bladeFrontUpper', 'bladeFrontLower', 'bladeFrontConnector'],
				emissive: true,
				alpha: 0xBF / 0xFF,
			},
			{},
		],
	},
	{
		id: 'mekanism:flamethrower',
		jar: MEKANISM,
		modelClass: 'model/ModelFlamethrower.class',
		texture: 'mekanism:render/flamethrower',
	},
	{
		id: 'mekanism:scuba_tank',
		jar: MEKANISM,
		modelClass: 'model/ModelScubaTank.class',
		texture: 'mekanism:render/scuba_set',
	},
	{
		id: 'mekanism:free_runners',
		jar: MEKANISM,
		modelClass: 'model/ModelFreeRunners.class',
		texture: 'mekanism:render/free_runners',
		// RenderFreeRunners adds a third op the others do not.
		pose: [
			{ translate: [0.5, 0.5, 0.5] },
			{ rotate: 'z', degrees: 180 },
			{ translate: [0, -1, 0] },
		],
	},
	{
		id: 'mekanism:jetpack',
		jar: MEKANISM,
		modelClass: 'model/ModelJetpack.class',
		texture: 'mekanism:render/jetpack',
		// wingParts: MekanismRenderType.JETPACK_GLASS, colour 0x34FFFFFF.
		groups: [
			{ parts: ['wingBladeL', 'wingBladeR'], emissive: true, alpha: 0x34 / 0xFF },
			{ parts: ['light1', 'light2', 'light3', 'packCore'], emissive: true },
			{},
		],
	},
	{
		id: 'mekanism:scuba_mask',
		jar: MEKANISM,
		modelClass: 'model/ModelScubaMask.class',
		texture: 'mekanism:render/scuba_set',
		// glass: MekanismRenderType.STANDARD, colour 0x4DFFFFFF.
		groups: [
			{
				parts: ['glassTop', 'glassFront', 'glassR', 'glassL', 'glassBackR', 'glassBackL'],
				emissive: true,
				alpha: 0x4D / 0xFF,
			},
			{ parts: ['lightL', 'lightR'], emissive: true },
			{},
		],
	},
];

const root = path.join(import.meta.dirname, '..', '..', 'assets', 'mod-models');
for (const spec of [...SPECS, ...BOTANIA_SPECS]) {
	const elements = await buildModel(spec, root);
	console.log(`${spec.id.padEnd(34)} ${elements} elements`);
}
