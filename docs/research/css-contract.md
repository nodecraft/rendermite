# CSS output contract

Read off the live `https://mc-assets.nodecraft.com/icons/1.21.8/rc-minecraft-64.css`
(renderchest v5.1.0 output, lightningcss-minified by the ui pipeline) on 2026-08-12.
This is the contract `NCMinecraftItem` consumes; the new generator must reproduce it.

## Structure (in source order)

1. **Glint keyframes**
   ```css
   @keyframes rc-enchanted {
     0% { background-position: -256px 1024px }
     to { background-position: 256px -1024px }
   }
   ```

2. **Base `.rc-item` rule** — default/placeholder + tint plumbing:
   ```css
   .rc-item {
     image-rendering: pixelated;
     background-image: url(items/renderchest/unknown.png);
     background-size: cover;
     background-color: var(--rc-layer-1-tint);
     background-blend-mode: multiply;
     position: relative;
     -webkit-mask-image: url(items/renderchest/unknown.png);
     -webkit-mask-size: cover;
   }
   ```
   Tinting works by multiply-blending `--rc-layer-1-tint` (set inline by the consumer) with the
   background image, masked to the sprite's own alpha via `-webkit-mask-image` (same image).

3. **Base `:before` rule** — second layer (overlay) + `--rc-layer-2-tint`:
   ```css
   .rc-item:before {
     content: ""; width: 100%; height: 100%;
     image-rendering: pixelated;
     background-image: url(items/renderchest/empty.png);
     background-size: cover;
     background-color: var(--rc-layer-2-tint);
     background-blend-mode: multiply;
     position: absolute; top: 0; left: 0;
     -webkit-mask-size: cover;
   }
   ```

4. **Per-item rules** (untinted single-layer items — the vast majority):
   ```css
   .rc-item.rc-minecraft_chest { background-image: url(items/minecraft/chest.png); -webkit-mask-image: none }
   .rc-item.rc-minecraft_chest.rc-enchanted { -webkit-mask-image: url(items/minecraft/chest.png) }
   ```
   `-webkit-mask-image: none` clears the base mask; the `.rc-enchanted` variant restores the
   mask so the glint (screen-blended `:after`) is clipped to the item silhouette.

5. **Tinted / layered items** set a default tint + separate base and mask images:
   ```css
   .rc-item.rc-minecraft_leather_chestplate {
     --rc-layer-1-tint: #9e643f;                       /* default leather colour */
     background-image: url(items/_leather_armor/leather_chestplate_base.png);
     -webkit-mask-image: url(items/minecraft/leather_chestplate.png);
   }
   .rc-item.rc-minecraft_leather_chestplate:before {
     background-image: url(items/_leather_armor/leather_chestplate_overlay.png);
     -webkit-mask-image: url(items/_leather_armor/leather_chestplate_overlay.png);
   }
   ```
   Potions likewise: `--rc-layer-1-tint:#f800f8` + `rc_potion_content.png` base masked by
   `potion.png`. Special generated assets live under prefixed dirs (`items/_leather_armor/`)
   or `rc_`-prefixed names inside `items/minecraft/`.

6. **Armor trims** — per-material `:before` variants:
   ```css
   .rc-item.rc-minecraft_leather_chestplate.rc-trim-minecraft_quartz:before {
     background-image: url(items/_leather_armor/leather_chestplate_quartz_trim.png);
     -webkit-mask-image: url(...same...);
   }
   ```

7. **Glint rule** — items that are always glinted get it unconditionally, unioned with
   `.rc-enchanted`:
   ```css
   .rc-item.rc-minecraft_experience_bottle:after,
   .rc-item.rc-minecraft_enchanted_golden_apple:after,
   .rc-item.rc-minecraft_enchanted_book:after,
   .rc-item.rc-minecraft_written_book:after,
   .rc-enchanted:after {
     width: 200%; height: 200%;
     image-rendering: pixelated;
     mix-blend-mode: screen;
     content: "";
     opacity: .6;
     filter: blur(2px) contrast(200%);
     background-image: url(rc-enchantment.png);
     background-size: 512px 512px;
     animation: rc-enchanted 32s linear infinite;
     position: absolute; top: -50%; left: -50%;
     transform: rotate(-8deg);
   }
   ```
   `rc-enchantment.png/webp` is written at the output root (512×512 source scaled).

8. **WebP override block** — everything above uses `.png`; a final block gated by
   `@media (resolution >= 1dpi)` repeats every rule that carries a `url()`, with `.webp`.
   The range-syntax media query doubles as a WebP-capability proxy (browsers too old for
   WebP also fail to parse it). This is what `--format webp --fallback` produces.

## Notes for the generator

- All `url()`s are relative to the stylesheet location (`items/...`, `rc-enchantment.png`).
  The modded publisher rebases them `../` because it moves sheets into `css/`. Our generator
  should take a configurable url prefix instead.
- Item ids sanitize to classes as `rc-` + id with `:` → `_` (consumer additionally maps
  `[^\w.-]` → `_`; renderchest historically wrote names unescaped — junk texture names broke
  whole sheets, so we must escape/sanitize selectors ourselves).
- No per-item `@keyframes` in vanilla 1.21.8 output: animated textures render as their first
  frame in the static icon (the only keyframes block is the glint). If older renderchest
  versions emitted sprite animations, that's out of contract today.
- `renderchest:unknown` and `renderchest:empty` placeholder icons must exist (referenced by
  the base rules) — that's the `items/renderchest/` namespace.
- The consumer probes availability via computed style on `.rc-minecraft_stone`; every vanilla
  sheet must include it.
