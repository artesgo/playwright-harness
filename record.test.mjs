import { strict as assert } from 'node:assert';
import { test } from 'node:test';
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

test('modifier clicks record assertions and screenshots, plain clicks record clicks', () => {
	assert.equal(recordedAction({}), 'click');
	assert.equal(recordedAction({ altKey: true }), 'expectVisible');
	assert.equal(recordedAction({ shiftKey: true }), 'expectText');
	assert.equal(recordedAction({ ctrlKey: true }), 'screenshotElement');
	assert.equal(recordedAction({ metaKey: true }), 'screenshotElement');
});

test('only text-like inputs record fill steps', () => {
	assert.equal(isFillable('INPUT', 'text'), true);
	assert.equal(isFillable('INPUT', undefined), true);
	assert.equal(isFillable('TEXTAREA', undefined), true);
	assert.equal(isFillable('INPUT', 'checkbox'), false);
	assert.equal(isFillable('INPUT', 'file'), false);
	assert.equal(isFillable('INPUT', 'color'), false);
	assert.equal(isFillable('SELECT', undefined), false);
});

test('only non-typing keys record press steps', () => {
	assert.equal(isPressKey('Enter'), true);
	assert.equal(isPressKey('ArrowDown'), true);
	assert.equal(isPressKey('a'), false);
	assert.equal(isPressKey('Backspace'), false);
});

test('network URLs drop the harness origin but keep cross-origin URLs whole', () => {
	assert.equal(networkUrl('/api/items?page=2', 'http://localhost:5180/tab'), '/api/items?page=2');
	assert.equal(
		networkUrl('http://localhost:5180/api/items', 'http://localhost:5180/tab'),
		'/api/items'
	);
	assert.equal(
		networkUrl('https://api.example.com/items', 'http://localhost:5180/tab'),
		'https://api.example.com/items'
	);
	assert.equal(networkUrl('data:text/plain,hello', 'http://localhost:5180/tab'), '');
	assert.equal(networkUrl('', 'http://localhost:5180/tab'), '');
});

test('response waits group with the action that triggered them', () => {
	const groups = groupWaits([
		{ action: 'click', selector: '#go' },
		{ action: 'awaitResponse', value: '/api/items' },
		{ action: 'awaitResponse', value: '/api/user' },
		{ action: 'expectText', selector: 'h1', value: 'Done' }
	]);

	assert.equal(groups.length, 2);
	assert.equal(groups[0].step.action, 'click');
	assert.deepEqual(
		groups[0].waits.map((wait) => wait.value),
		['/api/items', '/api/user']
	);
	assert.equal(groups[1].step.action, 'expectText');
	assert.deepEqual(groups[1].waits, []);

	const [leading] = groupWaits([{ action: 'awaitResponse', value: '/api/items' }]);
	assert.deepEqual(leading.waits, []);
});

test('steps recorded at the same moment are flagged, other steps are not', () => {
	const steps = [
		{ action: 'click', time: 1000 },
		{ action: 'click', time: 1001 },
		{ action: 'click', time: 1400 },
		{ action: 'goto', time: 1000 },
		{ action: 'click' }
	];
	assert.equal(recordedAtSameTime(steps, steps[0], 0), true);
	assert.equal(recordedAtSameTime(steps, steps[1], 1), true);
	assert.equal(recordedAtSameTime(steps, steps[2], 2), false);
	assert.equal(recordedAtSameTime(steps, steps[3], 3), false);
	assert.equal(recordedAtSameTime(steps, steps[4], 4), false);
});

test('a label click targets the control its for attribute names', () => {
	const control = { tagName: 'INPUT' };
	const fake = (forId) => ({
		ownerDocument: { getElementById: (id) => (id === 'email' ? control : null) },
		closest: (selector) => (selector === 'label' && forId ? { getAttribute: () => forId } : null)
	});
	assert.equal(labelTarget(fake('email')), control);
	const missing = fake('missing');
	assert.equal(labelTarget(missing), missing);
	const unlabeled = fake(null);
	assert.equal(labelTarget(unlabeled), unlabeled);
});

test('element screenshot paths use the testid, then the selector', () => {
	assert.equal(screenshotName('[data-testid="play-button"]'), 'play-button');
	assert.equal(screenshotName('#main'), 'main');
	assert.equal(screenshotName('div > button'), 'div-button');
});

test('screenshots live under the suite folder, named by step and identifier', () => {
	assert.equal(suiteName('tablist.spec.ts'), 'tablist');
	assert.equal(suiteName('nested/flow.spec.ts'), 'nested/flow');
	assert.equal(
		screenshotPath('tests/tablist', { selector: '[data-testid="play-button"]' }, 0),
		'tests/tablist/01-play-button.png'
	);
	assert.equal(
		screenshotPath('tests/tablist', { selector: '[data-testid="play-button"]' }, 2, '-element'),
		'tests/tablist/03-play-button-element.png'
	);
	assert.equal(
		screenshotPath('tests/tablist', { action: 'goto', value: '/tab' }, 4),
		'tests/tablist/05-tab.png'
	);
});

test('role selectors use the Playwright locator syntax', () => {
	assert.equal(roleSelector('button', 'Save'), 'role=button[name="Save"]');
	assert.equal(roleSelector('link', 'Say "hi"'), 'role=link[name="Say \\"hi\\""]');
	assert.equal(roleSelector('', 'Save'), '');
	assert.equal(roleSelector('button', ''), '');
	assert.equal(cssString('a\\b"c'), 'a\\\\b\\"c');
});

test('role selectors round-trip through the parser', () => {
	assert.deepEqual(parseRoleSelector(roleSelector('button', 'Say "hi" \\ ok')), {
		role: 'button',
		name: 'Say "hi" \\ ok'
	});
	assert.equal(parseRoleSelector('[data-testid="play-button"]'), null);
	assert.equal(parseRoleSelector('#main'), null);
});
