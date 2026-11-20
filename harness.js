const $ = (id) => document.getElementById(id);

import {
	cssString,
	groupWaits,
	isFillable,
	isPressKey,
	labelTarget,
	networkUrl,
	parseRoleSelector,
	recordedAction,
	recordedAtSameTime,
	roleSelector,
	screenshotName,
	screenshotPath,
	suiteName
} from './record.mjs';
import { parseTestSteps } from './steps.mjs';

const OVERLAY_ID = 'harness-testid-overlay';

// camera outline for the per-step page screenshot toggle
const CAMERA_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>';

// framed image for the per-step element screenshot toggle
const ELEMENT_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';

const app = $('app');
const stepsEl = $('steps');
const stepsHint = $('steps-hint');
const suggestionsEl = $('suggestions');
const stepError = $('step-error');
const addStepButton = $('add-step');
const clearButton = $('clear-steps');
const copyButton = $('copy');

let steps = [];
let picking = false;
let showTestIds = false;
let copied = false;
let testIdSelectors = [];
let recording = false;
let recordNetwork = false;
let recordTimer;
let recordedPath = '';
let ignoreGotoUntil = 0;
let responseWaiters = [];
let testsDir = 'tests';
let suite = 'harness-test';
let shotPickStep = null;

const RESPONSE_TIMEOUT = 5000;

// a click that navigates already replays that navigation, so ignore the goto it triggers
const GOTO_AFTER_CLICK_DELAY = 1000;
let replaying = false;
let paused = false;
let resumeReplay = null;
let specFiles = [];

const action = () => $('action').value;
const selector = () => $('selector').value.trim();
const value = () => $('value').value.trim();
const shotPath = () => $('shot-path').value.trim();

const needsSelector = () => !['goto', 'screenshotPage'].includes(action());
const needsValue = () => ['fill', 'press', 'expectText', 'goto'].includes(action());
const needsPath = () => ['screenshotPage', 'screenshotElement'].includes(action());

function quote(text) {
	return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function stepCall(step) {
	const target = `page.locator(${quote(step.selector)})`;
	switch (step.action) {
		case 'goto':
			return `page.goto(${quote(step.value)})`;
		case 'click':
			return `${target}.click()`;
		case 'fill':
			return `${target}.fill(${quote(step.value)})`;
		case 'press':
			return `${target}.press(${quote(step.value)})`;
		case 'expectVisible':
			return `expect(${target}).toBeVisible()`;
		case 'expectNotVisible':
			return `expect(${target}).not.toBeVisible()`;
		case 'expectText':
			return `expect(${target}).toContainText(${quote(step.value)})`;
		case 'awaitResponse':
			return `page.waitForResponse((response) => response.url().includes(${quote(step.value)}))`;
		// scan utils for more actions
		case 'screenshotPage':
			return `saveScreenshot(page, ${quote(step.path)})`;
		case 'screenshotElement':
			return `saveElementScreenshot(page, ${quote(step.selector)}, ${quote(step.path)})`;
	}
}

// Start the recorded wait alongside the action that triggered it, or the response can
// arrive before the generated test begins waiting for it.
function stepLines(steps) {
	let index = 0;
	const folder = `${testsDir}/${suite}`;
	return groupWaits(steps).flatMap(({ step, waits }) => {
		const lines = [];
		if (!waits.length) {
			lines.push(`\tawait ${stepCall(step)};`);
		} else {
			lines.push(
				'\tawait Promise.all([',
				`\t\t${stepCall(step)},`,
				...waits.map((wait) => `\t\t${stepCall(wait)},`),
				'\t]);'
			);
		}
		if (step.screenshot) {
			lines.push(`\tawait saveScreenshot(page, ${quote(screenshotPath(folder, step, index))});`);
		}
		if (step.elementShot) {
			const path = screenshotPath(folder, { selector: step.elementShot }, index, '-element');
			lines.push(
				`\tawait saveElementScreenshot(page, ${quote(step.elementShot)}, ${quote(path)});`
			);
		}
		index += 1 + waits.length;
		return lines;
	});
}

function describeStep(step) {
	switch (step.action) {
		case 'goto':
			return { label: 'goto', detail: step.value };
		case 'click':
			return { label: 'click', detail: step.selector };
		case 'fill':
			return { label: 'fill', detail: `${step.selector} = ${step.value}` };
		case 'press':
			return { label: 'press', detail: `${step.value} on ${step.selector}` };
		case 'expectVisible':
			return { label: 'visible', detail: step.selector };
		case 'expectText':
			return { label: 'expect text', detail: `${step.value} in ${step.selector}` };
		case 'awaitResponse':
			return { label: 'await response', detail: step.value };
		case 'screenshotPage':
			return { label: 'screenshot page', detail: `to ${step.path}` };
		case 'screenshotElement':
			return { label: 'screenshot element', detail: `${step.selector} to ${step.path}` };
	}
}

function generatedCode() {
	const pageShot = steps.some((step) => step.action === 'screenshotPage' || step.screenshot);
	const elementShot = steps.some(
		(step) => step.action === 'screenshotElement' || step.elementShot
	);
	const shots = [pageShot && 'saveScreenshot', elementShot && 'saveElementScreenshot'].filter(
		Boolean
	);
	const imports = [
		`import { expect, test } from '@playwright/test';`,
		...(shots.length ? [`import { ${shots.join(', ')} } from './utils/screenshot';`] : []),
		''
	];

	if (!steps.length)
		return [...imports, "test('harness test', async ({ page }) => {});", ''].join('\n');

	return [
		...imports,
		`test('harness test', async ({ page }) => {`,
		...stepLines(steps),
		'});',
		''
	].join('\n');
}

function errorMessage() {
	if (action() === 'goto' && !value()) return 'Enter a URL path.';
	if (needsSelector() && !selector()) return 'Pick an element or enter a selector.';
	if (needsValue() && !value()) return 'Enter a value.';
	if (needsPath() && !shotPath()) return 'Enter a screenshot path.';
	return '';
}

const VALUE_LABELS = { goto: 'Path', press: 'Key', expectText: 'Text' };

function renderFields() {
	$('selector-field').hidden = !needsSelector();
	$('value-field').hidden = !needsValue();
	$('path-field').hidden = !needsPath();
	$('value-label').textContent = VALUE_LABELS[action()] ?? 'Value';
	$('value').placeholder = action() === 'goto' ? '/profile' : '';

	const message = errorMessage();
	stepError.textContent = message;
	stepError.hidden = !message;
	addStepButton.disabled = !!message || replaying;
}

function renderSteps() {
	stepsEl.innerHTML = steps
		.map((step, index) => {
			const info = describeStep(step);
			const shot = !!step.screenshot;
			const shotDisabled = replaying || step.action === 'awaitResponse';
			const elementShot = !!step.elementShot;
			const elementDisabled = replaying || step.action === 'awaitResponse';
			const warn = recordedAtSameTime(steps, step, index);
			return `<li>${warn ? '<span class="warn" title="Another action was recorded at the same time" aria-label="Another action was recorded at the same time">!</span>' : ''}<span class="step-text"><strong>${escapeHtml(info.label)}</strong><span class="step-detail">${escapeHtml(info.detail)}</span></span><button class="icon breakpoint${step.breakpoint ? ' on' : ''}" data-break="${index}" aria-pressed="${!!step.breakpoint}" title="Breakpoint: pause before this step" aria-label="Toggle breakpoint for step ${index + 1}">●</button><button class="icon camera${shot ? ' on' : ''}" data-shot="${index}" aria-pressed="${shot}" title="Page screenshot after this step" aria-label="Toggle page screenshot after step ${index + 1}"${shotDisabled ? ' disabled' : ''}>${CAMERA_ICON}</button><button class="icon element-shot${elementShot ? ' on' : ''}" data-element-shot="${index}" aria-pressed="${elementShot}" title="Element screenshot after this step" aria-label="Toggle element screenshot after step ${index + 1}"${elementDisabled ? ' disabled' : ''}>${ELEMENT_ICON}</button><button class="icon" data-index="${index}" aria-label="Remove step"${replaying ? ' disabled' : ''}>×</button></li>`;
		})
		.join('');
	stepsEl.hidden = !steps.length;
	stepsHint.hidden = !!steps.length;
	clearButton.disabled = !steps.length || replaying;
	addStepButton.disabled = !!errorMessage() || replaying;
	renderReplayButton();
}

function renderReplayButton() {
	const button = $('replay');
	button.textContent = paused ? 'Continue' : 'Replay';
	button.disabled = !steps.length || (replaying && !paused);
}

function renderCode() {
	$('code').textContent = generatedCode();
	copyButton.textContent = copied ? 'Copied' : 'Copy';
}

function addStep() {
	if (replaying || errorMessage()) return;
	steps = [...steps, { action: action(), selector: selector(), value: value(), path: shotPath() }];
	renderSteps();
	renderCode();
}

function removeStep(index) {
	if (replaying) return;
	steps = steps.filter((_, i) => i !== index);
	renderSteps();
	renderCode();
}

// toggle a page screenshot after the step at index
function toggleStepScreenshot(index) {
	const step = steps[index];
	if (replaying || !step) return;
	step.screenshot = !step.screenshot;
	renderSteps();
	renderCode();
}

// pick the element to screenshot after the step at index
function toggleStepElementScreenshot(index) {
	const step = steps[index];
	if (replaying || !step) return;
	if (step.elementShot) {
		step.elementShot = '';
		shotPickStep = null;
		renderSteps();
		renderCode();
		return;
	}
	shotPickStep = step;
	if (!showTestIds) toggleTestIds();
	setPicking(true);
	setStatus('Click the element to screenshot.');
}

function makeStep(action, fields = {}) {
	return { action, selector: '', value: '', path: '', ...fields };
}

function recordStep(step) {
	if (!replaying) {
		step.time = Date.now();
		steps = [...steps, step];
		renderSteps();
		renderCode();
	}
}

function framePath() {
	try {
		const { pathname, search, hash } = app.contentWindow.location;
		return pathname + search + hash;
	} catch {
		return '';
	}
}

function toggleRecording() {
	if (replaying) return;

	recording = !recording;
	$('record').textContent = recording ? 'Stop recording' : 'Record';
	$('record').classList.toggle('active', recording);
	$('record-bar').hidden = !recording;
	clearInterval(recordTimer);
	if (!recording) return;

	setupFrame();
	recordedPath = framePath();
	ignoreGotoUntil = 0;
	if (!steps.length && recordedPath) recordStep(makeStep('goto', { value: recordedPath }));

	// shortcut: 400ms polling instead of patching history, so SPA navigation is caught without touching the app
	recordTimer = setInterval(() => {
		const path = framePath();
		if (!path || path === recordedPath) return;
		recordedPath = path;
		if (Date.now() < ignoreGotoUntil) return;
		recordStep(makeStep('goto', { value: path }));
	}, 400);
}

// two interaction steps recorded back to back are likely one interaction recorded twice
function onRecordClick(event) {
	if (!recording || picking || replaying) return;
	const clicked = event.target;
	// never use instanceof across the iframe realm: its Element is not the parent's
	if (clicked?.nodeType !== 1) return;
	// a label click forwards to its control, so record the control rather than the label
	const element = labelTarget(clicked);

	const action = recordedAction(event);
	// typing already records a fill step, so focusing a text field should not add a click
	if (action === 'click' && isFillable(element.tagName, element.type)) return;

	// assertion and screenshot modifiers inspect the element instead of activating it
	if (action !== 'click') {
		event.preventDefault();
		event.stopImmediatePropagation();
	}

	const selector = buildSelector(element);

	if (action === 'expectText') {
		const text = (element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
		if (text) recordStep(makeStep(action, { selector, value: text }));
		return;
	}

	if (action === 'screenshotElement') {
		const path = `test-results/screenshots/${screenshotName(selector)}.png`;
		recordStep(makeStep(action, { selector, path }));
		return;
	}

	if (action === 'click') ignoreGotoUntil = Date.now() + GOTO_AFTER_CLICK_DELAY;
	recordStep(makeStep(action, { selector }));
}

function onRecordChange(event) {
	if (!recording || replaying) return;
	const element = event.target;
	if (element?.nodeType !== 1 || !isFillable(element.tagName, element.type)) return;
	recordStep(makeStep('fill', { selector: buildSelector(element), value: element.value }));
}

function onRecordKey(event) {
	if (!recording || replaying || picking || !isPressKey(event.key)) return;
	if (event.target?.nodeType !== 1) return;
	recordStep(makeStep('press', { selector: buildSelector(event.target), value: event.key }));
}

function onRecordRequest(event) {
	if (!recording || replaying || !recordNetwork || !event.detail) return;
	// a wait needs an action to pair with, or the generated test waits for nothing
	if (!steps.length) return;
	recordStep(makeStep('awaitResponse', { value: event.detail }));
}

function onNetworkResponse(event) {
	const waiter = responseWaiters.find((item) => event.detail.includes(item.url));
	if (!waiter) return;
	responseWaiters = responseWaiters.filter((item) => item !== waiter);
	waiter.resolve(true);
}

// replay waits for the same URL substring the generated test matches
function waitForNetwork(url) {
	return new Promise((resolve) => {
		const waiter = { url, resolve };
		responseWaiters.push(waiter);
		setTimeout(() => {
			responseWaiters = responseWaiters.filter((item) => item !== waiter);
			resolve(false);
		}, RESPONSE_TIMEOUT);
	});
}

function setStatus(message) {
	const status = $('action-status');
	status.textContent = message;
	status.hidden = !message;
}

// Replay drives the iframe itself; Playwright is not running here, so screenshots are skipped.
async function replay() {
	if (replaying || !steps.length) return;

	replaying = true;
	paused = false;
	renderSteps();

	const groups = groupWaits(steps);
	const total = steps.length;
	const delay = Math.max(0, Number($('replay-delay').value) || 0);
	let skipped = 0;

	try {
		for (const [index, { step, waits }] of groups.entries()) {
			const label = describeStep(step).label;
			if (step.breakpoint || waits.some((wait) => wait.breakpoint)) await pauseBefore(index, label);

			setStatus(`Replaying ${index + 1}/${groups.length}: ${label}`);

			const pending = waits.map((wait) => waitForNetwork(wait.value));
			const error = await runStep(step);
			if (error) {
				setStatus(`Replay stopped at step ${index + 1} (${label}): ${error}`);
				return;
			}
			for (const [waitIndex, resolved] of pending.entries()) {
				if (await resolved) continue;
				setStatus(
					`Replay stopped at step ${index + 1} (${label}): no response matching ${waits[waitIndex].value}`
				);
				return;
			}
			if (step.action.startsWith('screenshot')) skipped++;
			if (step.screenshot) skipped++;
			if (step.elementShot) skipped++;
			if (delay && index < groups.length - 1) {
				await new Promise((resolve) => setTimeout(resolve, delay));
			}
		}
		setStatus(
			`Replayed ${total} step${total === 1 ? '' : 's'}${skipped ? ` (${skipped} screenshot${skipped === 1 ? '' : 's'} skipped)` : ''}.`
		);
	} finally {
		replaying = false;
		paused = false;
		resumeReplay = null;
		renderSteps();
	}
}

function pauseBefore(index, label) {
	return new Promise((resolve) => {
		paused = true;
		resumeReplay = resolve;
		setStatus(`Paused before step ${index + 1} (${label}).`);
		renderReplayButton();
	});
}

function continueReplay() {
	const resume = resumeReplay;
	resumeReplay = null;
	paused = false;
	renderReplayButton();
	resume?.();
}

async function runStep(step) {
	if (step.action === 'screenshotPage' || step.action === 'screenshotElement') return '';
	if (step.action === 'awaitResponse') return 'await response needs an action before it';

	if (step.action === 'goto') {
		const path = localPath(step.value);
		$('app-path').value = path;
		await loadFrame(path);
		return '';
	}

	const element = await waitForElement(step.selector);
	if (!element) return `no visible element matches ${step.selector}`;

	switch (step.action) {
		case 'click':
			element.click();
			return '';
		case 'fill':
			setFieldValue(element, step.value);
			return '';
		case 'press':
			pressKey(element, step.value);
			return '';
		case 'expectVisible':
			return isVisible(element) ? '' : `${step.selector} is not visible`;
		case 'expectText':
			return (element.textContent ?? '').includes(step.value)
				? ''
				: `${step.selector} does not contain "${step.value}"`;
	}
	return '';
}

// recorded and absolute test URLs both map onto the proxied origin
function localPath(target) {
	if (!/^https?:\/\//i.test(target)) return target;
	const { pathname, search, hash } = new URL(target);
	return pathname + search + hash;
}

function loadFrame(path) {
	return new Promise((resolve) => {
		const done = () => {
			app.removeEventListener('load', done);
			resolve();
		};
		app.addEventListener('load', done);
		app.src = path;
		setTimeout(done, 5000);
	});
}

async function waitForElement(selector, timeout = 3000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		let element;
		try {
			element = findElements(selector).find(isVisible);
		} catch {
			return null;
		}
		if (element) return element;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return null;
}

// role= selectors are not CSS, so they need the same role/name matching Playwright uses
function findElements(selector) {
	const doc = iframeDoc();
	if (!doc) return [];
	const role = parseRoleSelector(selector);
	if (!role) return [...doc.querySelectorAll(selector)];
	return [...doc.querySelectorAll('*')].filter(
		(element) => roleOf(element) === role.role && accessibleName(element) === role.name
	);
}

function isVisible(element) {
	return !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
}

function setFieldValue(element, value) {
	const win = element.ownerDocument.defaultView;
	const proto =
		element.tagName === 'TEXTAREA'
			? win.HTMLTextAreaElement.prototype
			: win.HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, 'value').set.call(element, value);
	element.dispatchEvent(new win.Event('input', { bubbles: true }));
	element.dispatchEvent(new win.Event('change', { bubbles: true }));
}

// shortcut: synthetic keys do not run browser default actions (Enter will not submit a form)
function pressKey(element, key) {
	const win = element.ownerDocument.defaultView;
	element.focus();
	for (const type of ['keydown', 'keyup']) {
		element.dispatchEvent(new win.KeyboardEvent(type, { key, bubbles: true }));
	}
}

function setTab(name) {
	setCollapsed(false);
	for (const button of document.querySelectorAll('[data-tab]')) {
		button.classList.toggle('active', button.dataset.tab === name);
	}
	$('actions-panel').hidden = name !== 'actions';
	$('code-panel').hidden = name !== 'code';
	$('tests-panel').hidden = name !== 'tests';
}

function loadPath() {
	app.src = $('app-path').value.trim() || '/';
}

function iframeDoc() {
	try {
		return app.contentDocument;
	} catch {
		return null;
	}
}

function refreshTestIds() {
	const doc = iframeDoc();
	if (!doc) return;
	const ids = [...doc.querySelectorAll('[data-testid]')]
		.map((element) => element.getAttribute('data-testid'))
		.filter(Boolean);
	testIdSelectors = [...new Set(ids)].sort().map((id) => `[data-testid="${cssString(id)}"]`);
}

function openSuggestions() {
	refreshTestIds();
	const query = selector().toLowerCase();
	const matches = testIdSelectors.filter((item) => item.toLowerCase().includes(query)).slice(0, 30);

	suggestionsEl.innerHTML = matches
		.map((item) => `<li><button type="button">${escapeHtml(item)}</button></li>`)
		.join('');
	suggestionsEl.hidden = !matches.length;
	$('selector').setAttribute('aria-expanded', String(!!matches.length));
}

function closeSuggestions() {
	suggestionsEl.hidden = true;
	$('selector').setAttribute('aria-expanded', 'false');
}

function setPicking(value) {
	picking = value;
	$('pick').textContent = picking ? 'Click an element…' : 'Pick element';
	$('pick').classList.toggle('active', picking);
	$('pick-inline').classList.toggle('active', picking);
	setupFrame();
	const doc = iframeDoc();
	if (doc?.body) doc.body.style.cursor = picking ? 'crosshair' : '';
}

function togglePick() {
	if (replaying) return;
	shotPickStep = null;
	setPicking(!picking);
}

function onPick(event) {
	if (!picking || replaying) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	const target = buildSelector(event.target);
	setPicking(false);
	if (shotPickStep) {
		const step = shotPickStep;
		shotPickStep = null;
		step.elementShot = target;
		setStatus('');
		renderSteps();
		renderCode();
		return;
	}
	$('selector').value = target;
	renderFields();
}

function toggleTestIds() {
	showTestIds = !showTestIds;
	$('toggle-testids').classList.toggle('active', showTestIds);
	applyTestIdOverlay();
}

function applyTestIdOverlay() {
	const doc = iframeDoc();
	if (!doc) return;
	const existing = doc.getElementById(OVERLAY_ID);
	if (!showTestIds) {
		existing?.remove();
		return;
	}
	if (existing) return;
	const style = doc.createElement('style');
	style.id = OVERLAY_ID;
	// shortcut: position: relative is forced on the host to anchor the label; drop the label if it ever breaks layout
	// nested testids step through a colour ramp so overlapping outlines stay distinguishable
	style.textContent = `
		[data-testid]:hover {
			--testid-colour: #ff00ff;
			position: relative;
			outline: 2px dashed var(--testid-colour) !important;
			outline-offset: -2px !important;
		}
		[data-testid] [data-testid]:hover {
			--testid-colour: #ffd400;
		}
		[data-testid] [data-testid] [data-testid]:hover {
			--testid-colour: #00e5ff;
		}
		[data-testid] [data-testid] [data-testid] [data-testid]:hover {
			--testid-colour: #7cff4f;
		}
		[data-testid] [data-testid] [data-testid] [data-testid] [data-testid]:hover {
			--testid-colour: #ff7a00;
		}
		[data-testid]:hover::after {
			content: attr(data-testid);
			position: absolute;
			top: 0;
			left: 0;
			transform: translateY(-100%);
			padding: 0 4px;
			border-radius: 2px 2px 0 0;
			background: var(--testid-colour);
			color: #111;
			font: 10px/1.4 ui-monospace, monospace;
			white-space: nowrap;
			pointer-events: none;
			z-index: 2147483647;
		}
	`;
	doc.head.append(style);
}

function cssIdent(text) {
	return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(text) : text;
}

const INTERACTIVE_SELECTOR = [
	'a[href]',
	'button',
	'input:not([type="hidden"])',
	'select',
	'textarea',
	'summary',
	'[role="button"]',
	'[role="link"]',
	'[role="checkbox"]',
	'[role="radio"]',
	'[role="switch"]',
	'[role="tab"]',
	'[role="menuitem"]',
	'[role="menuitemcheckbox"]',
	'[role="menuitemradio"]',
	'[role="option"]',
	'[role="combobox"]',
	'[role="textbox"]',
	'[role="searchbox"]',
	'[role="slider"]',
	'[role="spinbutton"]',
	'[contenteditable="true"]'
].join(',');

const CONTENT_ROLES = new Set([
	'button',
	'link',
	'heading',
	'option',
	'tab',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'checkbox',
	'radio',
	'switch',
	'treeitem',
	'cell',
	'columnheader',
	'gridcell',
	'rowheader',
	'tooltip'
]);

const INPUT_ROLES = {
	button: 'button',
	submit: 'button',
	reset: 'button',
	image: 'button',
	checkbox: 'checkbox',
	radio: 'radio',
	range: 'slider',
	number: 'spinbutton',
	search: 'searchbox'
};

function normalizeName(text) {
	return text.replace(/\s+/g, ' ').trim();
}

function roleOf(element) {
	const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
	if (explicit) return explicit;
	const tag = element.tagName;
	if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
	if (tag === 'A' && element.hasAttribute('href')) return 'link';
	if (tag === 'TEXTAREA') return 'textbox';
	if (tag === 'SELECT') return element.multiple || element.size > 1 ? 'listbox' : 'combobox';
	if (tag === 'IMG') return 'img';
	if (/^H[1-6]$/.test(tag)) return 'heading';
	if (tag === 'INPUT') {
		const type = (element.type || 'text').toLowerCase();
		if (type === 'hidden') return '';
		return INPUT_ROLES[type] ?? 'textbox';
	}
	return '';
}

// shortcut: covers the common accessible-name sources; extend if role selectors miss real widgets
function accessibleName(element) {
	const doc = element.ownerDocument;
	const labelledby = element.getAttribute('aria-labelledby');
	if (labelledby) {
		const text = normalizeName(
			labelledby
				.split(/\s+/)
				.map((id) => doc.getElementById(id)?.textContent ?? '')
				.join(' ')
		);
		if (text) return text;
	}

	const ariaLabel = normalizeName(element.getAttribute('aria-label') ?? '');
	if (ariaLabel) return ariaLabel;

	const labelText = normalizeName(
		(element.labels ? [...element.labels] : [])
			.map((label) => label.textContent)
			.join(' ')
	);
	if (labelText) return labelText;

	if (element.tagName === 'INPUT') {
		const type = (element.type || 'text').toLowerCase();
		if (['button', 'submit', 'reset'].includes(type) && element.value) {
			return normalizeName(element.value);
		}
		if (type === 'image' && element.alt) return normalizeName(element.alt);
	}

	if (element.tagName === 'IMG') {
		const alt = normalizeName(element.getAttribute('alt') ?? '');
		if (alt) return alt;
	}

	const placeholder = normalizeName(element.getAttribute('placeholder') ?? '');
	if (placeholder) return placeholder;

	if (CONTENT_ROLES.has(roleOf(element))) {
		const text = normalizeName(element.textContent ?? '');
		if (text) return text;
	}

	return normalizeName(element.getAttribute('title') ?? '');
}

function elementPath(element) {
	const parts = [];
	let node = element;
	while (node && node.tagName !== 'BODY' && node.tagName !== 'HTML' && parts.length < 6) {
		let part = node.tagName.toLowerCase();
		const parent = node.parentElement;
		if (parent) {
			const sameTag = [...parent.children].filter((child) => child.tagName === node.tagName);
			if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
		}
		parts.unshift(part);
		node = parent;
	}
	return parts.join(' > ');
}

function buildSelector(element) {
	// anchor on the clicked widget, not a distant ancestor that happens to have a test id
	const target = element.closest(INTERACTIVE_SELECTOR) ?? element;
	const testid = target.getAttribute('data-testid');
	if (testid) return `[data-testid="${cssString(testid)}"]`;
	if (target.id) return `#${cssIdent(target.id)}`;

	const role = roleOf(target);
	const byRole = role === 'presentation' || role === 'none' ? '' : roleSelector(role, accessibleName(target));
	if (byRole) return byRole;

	const fieldName = target.getAttribute('name');
	if (fieldName) return `${target.tagName.toLowerCase()}[name="${cssString(fieldName)}"]`;

	return elementPath(target);
}

function escapeHtml(text) {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;');
}

async function loadTarget() {
	const response = await fetch('/__harness/config');
	if (!response.ok) return;
	const { app, tests } = await response.json();
	$('app-target').textContent = `→ ${app}`;
	if (tests && tests !== testsDir) {
		testsDir = tests;
		renderCode();
	}
}

async function refreshSpecs() {
	const response = await fetch('/__harness/specs');
	if (!response.ok) return;
	specFiles = await response.json();
	$('tests-tab').textContent = `Tests (${specFiles.length})`;
	$('tests-panel').innerHTML = specFiles.length
		? specFiles
				.map(
					(spec, specIndex) =>
						`<details><summary>${escapeHtml(spec.file)}<span class="count">${spec.tests.length} tests</span></summary><ul>${spec.tests
							.map(
								(title, testIndex) =>
									`<li><button class="test-load primary" data-spec="${specIndex}" data-test="${testIndex}">Load</button>${escapeHtml(title)}</li>`
							)
							.join('')}</ul><pre>${escapeHtml(spec.source)}</pre></details>`
				)
				.join('')
		: '<p class="hint">No *.spec.ts files under the tests directory.</p>';
}

function loadTest(specIndex, testIndex) {
	if (replaying) return;

	const spec = specFiles[specIndex];
	const title = spec?.tests[testIndex];
	if (!title) return;

	const { steps: parsed, skipped } = parseTestSteps(spec.source, title);
	if (!parsed.length) {
		setTab('tests');
		setStatus(`No replayable steps in "${title}".`);
		return;
	}

	steps = parsed;
	suite = suiteName(spec.file);
	setTab('actions');
	renderSteps();
	renderCode();
	setStatus(
		`Loaded ${parsed.length} steps from "${title}"${skipped ? ` (${skipped} unsupported line${skipped === 1 ? '' : 's'} skipped)` : ''}.`
	);
}

$('load').addEventListener('click', loadPath);
$('app-path').addEventListener('keydown', (event) => {
	if (event.key === 'Enter') loadPath();
});
$('reload').addEventListener('click', () => app.contentWindow?.location.reload());
$('record').addEventListener('click', toggleRecording);
$('record-shot').addEventListener('click', () =>
	recordStep(makeStep('screenshotPage', { path: shotPath() }))
);
$('record-network').addEventListener('click', () => {
	recordNetwork = !recordNetwork;
	$('record-network').classList.toggle('active', recordNetwork);
});
$('pick').addEventListener('click', togglePick);
$('pick-inline').addEventListener('click', togglePick);
$('toggle-testids').addEventListener('click', toggleTestIds);
$('refresh-tests').addEventListener('click', refreshSpecs);
$('action').addEventListener('change', renderFields);
$('clear-steps').addEventListener('click', () => {
	steps = [];
	renderSteps();
	renderCode();
	setStatus('');
});
addStepButton.addEventListener('click', addStep);
$('replay').addEventListener('click', () => (paused ? continueReplay() : replay()));

$('tests-panel').addEventListener('click', (event) => {
	const button = event.target.closest('button[data-spec]');
	if (button) loadTest(Number(button.dataset.spec), Number(button.dataset.test));
});
copyButton.addEventListener('click', async () => {
	await navigator.clipboard.writeText(generatedCode());
	copied = true;
	renderCode();
	setTimeout(() => {
		copied = false;
		renderCode();
	}, 1500);
});

stepsEl.addEventListener('click', (event) => {
	const toggle = event.target.closest('button[data-break]');
	if (toggle) {
		const step = steps[Number(toggle.dataset.break)];
		if (step) step.breakpoint = !step.breakpoint;
		renderSteps();
		return;
	}

	const shot = event.target.closest('button[data-shot]');
	if (shot) {
		toggleStepScreenshot(Number(shot.dataset.shot));
		return;
	}

	const elementShot = event.target.closest('button[data-element-shot]');
	if (elementShot) {
		toggleStepElementScreenshot(Number(elementShot.dataset.elementShot));
		return;
	}

	const button = event.target.closest('button[data-index]');
	if (button) removeStep(Number(button.dataset.index));
});

for (const field of [$('value'), $('shot-path')]) {
	field.addEventListener('input', renderFields);
}

$('selector').addEventListener('focus', openSuggestions);
$('selector').addEventListener('input', () => {
	openSuggestions();
	renderFields();
});
$('selector').addEventListener('blur', closeSuggestions);
$('selector').addEventListener('keydown', (event) => {
	if (event.key === 'Escape') closeSuggestions();
});

// mousedown beats blur, so the click lands before the list closes
suggestionsEl.addEventListener('mousedown', (event) => event.preventDefault());
suggestionsEl.addEventListener('click', (event) => {
	const button = event.target.closest('button');
	if (!button) return;
	$('selector').value = button.textContent;
	closeSuggestions();
	renderFields();
});

const panel = $('panel');
const panelHead = panel.querySelector('.panel-head');
let drag = null;

const clamp = (value, min, max) => Math.min(Math.max(value, min), Math.max(min, max));

// keep the panel inside the stage after dragging or expanding
function movePanel(left, top) {
	const stage = panel.parentElement;
	panel.style.left = `${clamp(left, 0, stage.clientWidth - panel.offsetWidth)}px`;
	panel.style.top = `${clamp(top, 0, stage.clientHeight - panel.offsetHeight)}px`;
}

function setCollapsed(collapsed) {
	panel.classList.toggle('collapsed', collapsed);
	$('collapse').textContent = collapsed ? '▴' : '▾';
	$('collapse').setAttribute('aria-expanded', String(!collapsed));
	// expanding a dragged panel at the right edge would run off-screen
	if (!collapsed && panel.style.left) movePanel(panel.offsetLeft, panel.offsetTop);
}

$('collapse').addEventListener('click', () => {
	setCollapsed(!panel.classList.contains('collapsed'));
});

panelHead.addEventListener('pointerdown', (event) => {
	if (event.button !== 0 || event.target.closest('button')) return;
	const rect = panel.getBoundingClientRect();
	const stageRect = panel.parentElement.getBoundingClientRect();
	drag = {
		x: event.clientX,
		y: event.clientY,
		left: rect.left - stageRect.left,
		top: rect.top - stageRect.top
	};
	// the panel is anchored bottom-right until it is dragged, so switch to left/top
	panel.style.right = 'auto';
	panel.style.bottom = 'auto';
	movePanel(drag.left, drag.top);
	panelHead.setPointerCapture(event.pointerId);
	event.preventDefault();
});

panelHead.addEventListener('pointermove', (event) => {
	if (!drag) return;
	movePanel(drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
});

for (const type of ['pointerup', 'pointercancel']) {
	panelHead.addEventListener(type, () => (drag = null));
}

for (const button of document.querySelectorAll('[data-tab]')) {
	button.addEventListener('click', () => setTab(button.dataset.tab));
}

app.addEventListener('load', setupFrame);

// shortcut: observability stops at fetch and XHR, and only after the iframe loads;
// WebSocket, sendBeacon and EventSource are not recorded
function watchNetwork(doc) {
	const win = doc.defaultView;
	if (!win || win.harnessNetwork) return;
	win.harnessNetwork = true;

	const notify = (type, url) => {
		if (url) doc.dispatchEvent(new win.CustomEvent(`harness:${type}`, { detail: url }));
	};

	const originalFetch = win.fetch;
	if (originalFetch) {
		win.fetch = function (...args) {
			const url = networkUrl(args[0], win.location.href);
			notify('request', url);
			return originalFetch.apply(this, args).then((response) => {
				notify('response', url);
				return response;
			});
		};
	}

	const xhr = win.XMLHttpRequest?.prototype;
	if (xhr) {
		const open = xhr.open;
		xhr.open = function (method, url, ...rest) {
			this.harnessUrl = networkUrl(url, win.location.href);
			return open.call(this, method, url, ...rest);
		};
		const send = xhr.send;
		xhr.send = function (...args) {
			notify('request', this.harnessUrl);
			this.addEventListener('load', () => notify('response', this.harnessUrl));
			return send.apply(this, args);
		};
	}
}

function setupFrame() {
	const doc = iframeDoc();
	if (!doc) return;
	// the iframe can load before this module runs, and each new document needs its listeners again
	if (!doc.harnessReady) {
		doc.harnessReady = true;
		doc.addEventListener('click', onPick, true);
		doc.addEventListener('click', onRecordClick, true);
		doc.addEventListener('change', onRecordChange, true);
		doc.addEventListener('keydown', onRecordKey, true);
		doc.addEventListener('harness:request', onRecordRequest);
		doc.addEventListener('harness:response', onNetworkResponse);
		watchNetwork(doc);
	}
	refreshTestIds();
	applyTestIdOverlay();
}

// the iframe may already be loaded, so set up once directly; load covers later navigations
setupFrame();

renderFields();
renderSteps();
renderCode();
loadTarget();
refreshSpecs();
