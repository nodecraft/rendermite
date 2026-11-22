/// <reference lib="dom" />
import { createHostedClient } from './client.ts';
import {
	HOSTED_BASE_URL,
	glintUrl,
	iconUrl,
	qualify,
} from './urls.ts';
import { ENCHANTED_EFFECT_ITEMS } from '../output/css-contract.ts';

import type { HostedClient } from './client.ts';

export interface ItemElementOptions {
	/** Defaults to `rc-item`. */
	tagName?: string;
	baseUrl?: string;
	/** Resolves the latest version for elements without one; shared across every element. */
	client?: HostedClient;
}

/*
 * The standalone images are already composited with their default tints, so one
 * image per icon is enough and a page never pays for a whole stylesheet. Only the
 * glint is drawn here, matching the stylesheet's glint rule.
 */
const STYLES = `
:host{display:inline-block;width:64px;height:64px;vertical-align:middle}
.icon{display:block;position:relative;width:100%;height:100%;overflow:hidden;mask-size:cover}
img{display:block;width:100%;height:100%;image-rendering:pixelated}
:host([missing]) img{visibility:hidden}
.glint{display:none;position:absolute;top:-50%;left:-50%;width:200%;height:200%;mix-blend-mode:screen;opacity:.6;background-image:var(--rc-glint);background-size:512px 512px;transform:rotate(-8deg);animation:rc-enchanted 32s steps(480,end) infinite;pointer-events:none}
.icon.enchanted{mask-image:var(--rc-mask)}
.icon.enchanted .glint{display:block}
@keyframes rc-enchanted{0%{background-position:-256px 1024px}to{background-position:256px -1024px}}
@media (prefers-reduced-motion:reduce){.glint{animation:none}}
`;

/**
 * Registers `<rc-item item="create:wrench">`, an icon from the hosted CDN that
 * needs no stylesheet. Attributes: `item`, `version` (latest when omitted),
 * `enchanted`, and `label` for its accessible name. It reflects a `missing`
 * attribute when the image fails to load. Safe to call during server rendering,
 * where it does nothing.
 */
export function defineItemElement(options: ItemElementOptions = {}): void {
	const tagName = options.tagName ?? 'rc-item';
	if (typeof customElements === 'undefined' || customElements.get(tagName)) {
		return;
	}
	const baseUrl = options.baseUrl ?? HOSTED_BASE_URL;
	let client = options.client;

	class ItemElement extends HTMLElement {
		static observedAttributes = ['item', 'version', 'enchanted', 'label'];

		#internals = this.attachInternals();
		#icon = document.createElement('span');
		#image = document.createElement('img');
		#renders = 0;

		constructor() {
			super();
			const style = document.createElement('style');
			style.textContent = STYLES;
			const glint = document.createElement('span');
			glint.className = 'glint';
			glint.part.add('glint');
			this.#icon.className = 'icon';
			this.#icon.part.add('icon');
			this.#image.alt = '';
			this.#image.part.add('image');
			this.#icon.append(this.#image, glint);
			this.attachShadow({ mode: 'open' }).append(style, this.#icon);
			this.#internals.role = 'img';
			this.#image.addEventListener('load', () => this.removeAttribute('missing'));
			this.#image.addEventListener('error', () => this.setAttribute('missing', ''));
		}

		#render(): void {
			const render = ++this.#renders;
			const item = this.getAttribute('item');
			this.#internals.ariaLabel = this.getAttribute('label') ?? item;
			if (!item) {
				return;
			}
			this.#version().then((version) => {
				// Attributes may have changed while the version was loading.
				if (render !== this.#renders) {
					return;
				}
				const url = iconUrl(item, { version, baseUrl });
				const enchanted = this.hasAttribute('enchanted') || ENCHANTED_EFFECT_ITEMS.has(qualify(item));
				this.#icon.classList.toggle('enchanted', enchanted);
				this.#icon.style.setProperty('--rc-mask', `url("${url}")`);
				this.#icon.style.setProperty('--rc-glint', `url("${glintUrl(version, baseUrl)}")`);
				this.#image.src = url;
			}).catch(() => {
				if (render === this.#renders) {
					this.setAttribute('missing', '');
				}
			});
		}

		async #version(): Promise<string> {
			const version = this.getAttribute('version');
			if (version) {
				return version;
			}
			client ??= createHostedClient({ baseUrl });
			return client.latestVersion();
		}

		connectedCallback(): void {
			this.#render();
		}

		attributeChangedCallback(): void {
			if (this.isConnected) {
				this.#render();
			}
		}
	}

	customElements.define(tagName, ItemElement);
}
