import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSpecFiles } from './specs.mjs';

test('reads spec files recursively with their test titles', async (t) => {
	const dir = await mkdtemp(join(tmpdir(), 'harness-specs-'));
	t.after(() => rm(dir, { recursive: true, force: true }));

	await writeFile(
		join(dir, 'routes.spec.ts'),
		"test('first', async () => {});\ntest.describe('group');\ntest.skip('second', () => {});"
	);
	await writeFile(join(dir, 'ignored.ts'), "test('not a spec', () => {});");
	await mkdir(join(dir, 'nested'));
	await writeFile(join(dir, 'nested', 'extra.spec.ts'), "test('third', () => {});");

	const specs = await readSpecFiles(dir);

	assert.deepEqual(
		specs.map((spec) => spec.file),
		['nested/extra.spec.ts', 'routes.spec.ts']
	);
	assert.deepEqual(specs.find((spec) => spec.file === 'routes.spec.ts')?.tests, [
		'first',
		'second'
	]);
	assert.deepEqual(specs.find((spec) => spec.file === 'nested/extra.spec.ts')?.tests, ['third']);
});

test('returns an empty list for a missing directory', async () => {
	assert.deepEqual(await readSpecFiles(join(tmpdir(), 'harness-specs-missing')), []);
});
