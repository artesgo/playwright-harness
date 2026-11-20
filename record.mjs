// Pure helpers for record mode, kept out of harness.js so they can be tested in Node.

const FILLABLE_INPUTS = new Set([
	'text',
	'email',
	'password',
	'search',
	'tel',
	'url',
	'number',
	'date',
	'time',
	'datetime-local',
	'month',
	'week'
]);

const PRESS_KEYS = new Set([
	'Enter',
	'Escape',
	'Home',
	'End',
	'PageUp',
	'PageDown',
	'ArrowUp',
	'ArrowDown',
	'ArrowLeft',
	'ArrowRight'
]);

// A modifier turns a click into an assertion or screenshot instead of an action.
export function recordedAction(modifiers) {
	if (modifiers.altKey) return 'expectVisible';
	if (modifiers.shiftKey) return 'expectText';
	if (modifiers.ctrlKey || modifiers.metaKey) return 'screenshotElement';
	return 'click';
}

export function isFillable(tagName, type) {
	if (tagName === 'TEXTAREA') return true;
	return tagName === 'INPUT' && FILLABLE_INPUTS.has((type || 'text').toLowerCase());
}

export function isPressKey(key) {
	return PRESS_KEYS.has(key);
}

// Responses are matched by URL substring, so drop the harness origin from same-origin
// URLs: the generated test runs against the app origin instead.
export function networkUrl(input, base) {
	const raw = typeof input === 'string' ? input : (input?.url ?? input?.href ?? '');
	if (!raw) return '';
	try {
		const url = new URL(raw, base);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
		return url.origin === new URL(base).origin ? url.pathname + url.search : url.href;
	} catch {
		return '';
	}
}

// A recorded response wait sits right after the action that triggered it, so generation
// can wrap the pair in Promise.all and replay can start the wait before the action.
export function groupWaits(steps) {
	const groups = [];
	for (const step of steps) {
		const previous = groups.at(-1);
		if (step.action === 'awaitResponse' && previous) previous.waits.push(step);
		else groups.push({ step, waits: [] });
	}
	return groups;
}

const ACTION_STEPS = new Set(['click', 'fill', 'press']);
const SAME_TIME_WINDOW = 100;

// Two action steps recorded this close are most likely one interaction recorded twice.
export function recordedAtSameTime(steps, step, index) {
	if (!step.time || !ACTION_STEPS.has(step.action)) return false;
	return steps.some(
		(other, otherIndex) =>
			otherIndex !== index &&
			other.time &&
			ACTION_STEPS.has(other.action) &&
			Math.abs(other.time - step.time) <= SAME_TIME_WINDOW
	);
}

// A label click is forwarded to the control its for attribute names, so record that.
export function labelTarget(element) {
	const label = element?.closest?.('label');
	const id = label?.getAttribute('for');
	return (id && element.ownerDocument.getElementById(id)) || element;
}

export function screenshotName(selector) {
	const testid = /\[data-testid="(.+)"\]/.exec(selector)?.[1];
	const base = testid ?? selector.replace(/[^\w-]+/g, '-');
	return base.replace(/^-+|-+$/g, '') || 'element';
}

// A spec file is the suite: its screenshots live in a folder of the same name.
export function suiteName(file) {
	return file.replace(/\.spec\.ts$/, '');
}

// The screenshot name is the step number plus the test id, or the best selector slug.
export function screenshotPath(folder, step, index, suffix = '') {
	const source = step.selector || step.value || step.action;
	const name = `${String(index + 1).padStart(2, '0')}-${screenshotName(source)}${suffix}`;
	return `${folder}/${name}.png`;
}

export function cssString(text) {
	return text.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

// Playwright's recommended locator when there is no test id: getByRole(name)
export function roleSelector(role, name) {
	if (!role || !name) return '';
	return `role=${role}[name="${cssString(name)}"]`;
}

// Returns null for CSS selectors so callers can fall back to querySelector.
export function parseRoleSelector(selector) {
	const match = /^role=([\w-]+)\[name="((?:[^"\\]|\\.)*)"\]$/.exec(selector);
	if (!match) return null;
	return { role: match[1], name: match[2].replace(/\\(.)/g, '$1') };
}
