import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseTestSteps } from './steps.mjs';

const SOURCE = `
import { expect, test } from '@playwright/test';
import { saveElementScreenshot, saveScreenshot } from './utils/screenshot';

test.describe('group', () => {
	test('loads everything', async ({ page }) => {
		await page.goto('/start');
		const name = page.locator('[data-testid="name"]');
		await name.fill('hello');
		await page.locator('[data-testid="name"]').press('Enter');
		await page.locator('[data-testid="agree"]').click();
		await expect(page.locator('[data-testid="message"]')).toBeVisible();
		await expect(page.locator('[data-testid="message"]')).toContainText('Hello there');
		await saveElementScreenshot(page, '[data-testid="message"]', 'shots/message.png');
		await saveScreenshot(page, 'shots/page.png');
		await page.waitForTimeout(1000);
	});
});
`;

test('loads every supported action in source order', () => {
	const { steps } = parseTestSteps(SOURCE, 'loads everything');

	assert.deepEqual(
		steps.map((step) => step.action),
		[
			'goto',
			'fill',
			'press',
			'click',
			'expectVisible',
			'expectText',
			'screenshotElement',
			'screenshotPage'
		]
	);
	assert.deepEqual(steps[0], { action: 'goto', selector: '', value: '/start', path: '' });
	assert.deepEqual(steps[1], {
		action: 'fill',
		selector: '[data-testid="name"]',
		value: 'hello',
		path: ''
	});
	assert.deepEqual(steps[6], {
		action: 'screenshotElement',
		selector: '[data-testid="message"]',
		value: '',
		path: 'shots/message.png'
	});
});

test('reports statements the harness cannot replay', () => {
	const { skipped } = parseTestSteps(SOURCE, 'loads everything');
	assert.equal(skipped, 1);
});

test('returns nothing for an unknown title', () => {
	assert.deepEqual(parseTestSteps(SOURCE, 'nope'), { steps: [], skipped: 0 });
});

const GROUPED = `
test('grouped', async ({ page }) => {
	await page.goto('/start');
	await test.step('sign in', async () => {
		await page.locator('[data-testid="user"]').fill('me');
		await test.step('submit', async () => {
			await page.locator('[data-testid="go"]').click();
		});
	});
	await expect(page.locator('[data-testid="done"]')).toBeVisible();
});
`;

test('nests test.step blocks as group paths', () => {
	const { steps, skipped } = parseTestSteps(GROUPED, 'grouped');

	assert.deepEqual(
		steps.map((step) => step.action),
		['goto', 'fill', 'click', 'expectVisible']
	);
	assert.equal(steps[0].group, undefined);
	assert.deepEqual(steps[1].group, [{ id: 0, name: 'sign in' }]);
	assert.deepEqual(steps[2].group, [
		{ id: 0, name: 'sign in' },
		{ id: 1, name: 'submit' }
	]);
	assert.equal(steps[3].group, undefined);
	assert.equal(skipped, 0);
});
