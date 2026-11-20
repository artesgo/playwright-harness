import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

// shortcut: regex title extraction, switch to an AST if titles start containing quotes
const TEST_TITLE = /(?:^|\n)\s*test(?!\.describe)(?:\.\w+)?\s*\(\s*(['"`])([^'"`\n]+)\1/g;

async function findSpecs(dir) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files = await Promise.all(
		entries.map((entry) => {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) return findSpecs(full);
			return entry.name.endsWith('.spec.ts') ? [full] : [];
		})
	);
	return files.flat();
}

export async function readSpecFiles(testsDir) {
	const files = (await findSpecs(testsDir)).sort();
	return Promise.all(
		files.map(async (file) => {
			const source = await readFile(file, 'utf8');
			return {
				file: relative(testsDir, file).replaceAll('\\', '/'),
				source,
				tests: [...source.matchAll(TEST_TITLE)].map((match) => match[2])
			};
		})
	);
}
