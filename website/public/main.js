const ASSETS = 'https://assets.rendermite.dev';
const ITEM_ID = /^(?:([\d._a-z-]+):)?([\d./_a-z-]+)$/;

function setupTooltips() {
	const tooltip = document.querySelector('#tooltip');

	function show(slot) {
		const { name, id, mod, note, rarity } = slot.dataset;
		const nameLine = document.createElement('div');
		nameLine.className = 'tooltip-name';
		nameLine.textContent = name;
		if (rarity) {
			nameLine.dataset.rarity = rarity;
		}
		const lines = [nameLine];
		if (note) {
			lines.push(Object.assign(document.createElement('div'), { className: 'tooltip-note', textContent: note }));
		}
		lines.push(Object.assign(document.createElement('div'), { className: 'tooltip-id', textContent: id }));
		if (mod) {
			lines.push(Object.assign(document.createElement('div'), { className: 'tooltip-mod', textContent: mod }));
		}
		tooltip.replaceChildren(...lines);
		tooltip.hidden = false;

		// Sit above the slot like the game does, but stay inside the viewport on narrow screens.
		const slotBox = slot.getBoundingClientRect();
		const tipBox = tooltip.getBoundingClientRect();
		const left = Math.min(Math.max(8, slotBox.left), window.innerWidth - tipBox.width - 8);
		let top = slotBox.top - tipBox.height - 6;
		if (top < 8) {
			top = slotBox.bottom + 6;
		}
		tooltip.style.left = `${left}px`;
		tooltip.style.top = `${top}px`;
	}

	function hide() {
		tooltip.hidden = true;
	}

	for (const slot of document.querySelectorAll('.slot')) {
		slot.setAttribute('aria-label', slot.dataset.mod ? `${slot.dataset.name}, ${slot.dataset.mod}` : slot.dataset.name);
		slot.addEventListener('mouseenter', () => show(slot));
		slot.addEventListener('focus', () => show(slot));
		slot.addEventListener('mouseleave', hide);
		slot.addEventListener('blur', hide);
	}
	window.addEventListener('scroll', hide, { passive: true });
}

function setupCopyButtons() {
	for (const button of document.querySelectorAll('[data-copy]')) {
		button.addEventListener('click', async () => {
			const source = document.querySelector(button.dataset.copy);
			try {
				await navigator.clipboard.writeText(source.textContent);
				button.textContent = 'Copied';
				button.dataset.state = 'done';
			} catch {
				// Clipboard access can be refused; selecting the text still lets the reader copy it by hand.
				window.getSelection().selectAllChildren(source);
				button.textContent = 'Selected';
			}
			setTimeout(() => {
				button.textContent = 'Copy';
				delete button.dataset.state;
			}, 1600);
		});
	}
}

function setupLookup() {
	const form = document.querySelector('#lookup');
	const idInput = document.querySelector('#lookup-id');
	const versionSelect = document.querySelector('#lookup-version');
	const image = document.querySelector('#lookup-img');
	const url = document.querySelector('#lookup-url');
	const status = document.querySelector('#lookup-status');

	function setStatus(message, state) {
		status.textContent = message;
		if (state) {
			status.dataset.state = state;
		} else {
			delete status.dataset.state;
		}
	}

	function update() {
		const match = ITEM_ID.exec(idInput.value.trim().toLowerCase());
		if (!match) {
			setStatus('Use an item id like minecraft:diamond_sword or create:cogwheel.', 'error');
			return;
		}
		const namespace = match[1] ?? 'minecraft';
		const path = match[2];
		const version = versionSelect.value;
		let iconUrl;
		if (namespace === 'minecraft') {
			iconUrl = `${ASSETS}/icons/${version}/items/minecraft/${path}.webp`;
			setStatus(`Vanilla icon from ${version}.`);
		} else {
			iconUrl = `${ASSETS}/icons/modded/items/${namespace}/${path}.webp`;
			setStatus('Modded icons are shared across versions, so the version is ignored.');
		}
		url.textContent = iconUrl;
		image.dataset.state = 'loading';
		image.src = iconUrl;
	}

	image.addEventListener('load', () => {
		image.dataset.state = 'ok';
	});
	image.addEventListener('error', () => {
		image.dataset.state = 'missing';
		setStatus('No icon at that path. Item ids change between versions, so check items-<version>.json for the exact id.', 'error');
	});

	form.addEventListener('submit', (event) => {
		event.preventDefault();
		update();
	});
	idInput.addEventListener('change', update);
	versionSelect.addEventListener('change', update);
}

setupTooltips();
setupCopyButtons();
setupLookup();
