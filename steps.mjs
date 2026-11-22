// Parses harness-shaped Playwright tests back into steps, so a test can be
// loaded into the Actions tab. Browser-safe: no Node APIs.

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// shortcut: brace counting ignores braces inside strings, good enough for spec files
function testBody(source, title) {
	const opener = new RegExp(`test(?:\\.\\w+)?\\(\\s*(['"\`])${escapeRegExp(title)}\\1`);
	const match = opener.exec(source);
	if (!match) return '';

	const arrow = source.indexOf('=>', match.index);
	if (arrow < 0) return '';
	const start = source.indexOf('{', arrow);
	if (start < 0) return '';
	let depth = 0;
	for (let index = start; index < source.length; index++) {
		if (source[index] === '{') depth++;
		else if (source[index] === '}' && --depth === 0) return source.slice(start + 1, index);
	}
	return '';
}

// const password = page.locator('#password') -> inline the locator at every use
function expandAliases(body) {
	let result = body;
	for (const match of body.matchAll(
		/const\s+([\w$]+)\s*=\s*(page\.locator\(\s*(['"`]).*?\3\s*\))\s*;/g
	)) {
		result = result.replaceAll(`${match[1]}.`, `${match[2]}.`);
	}
	return result;
}

// test.step('name', async () => { ... }) wraps the steps inside it into a group
function groupRanges(body) {
	const ranges = [];
	for (const match of body.matchAll(/\btest\.step\(\s*(['"`])([^'"`\n]*)\1/g)) {
		const arrow = body.indexOf('=>', match.index);
		if (arrow < 0) continue;
		const start = body.indexOf('{', arrow);
		if (start < 0 || body.slice(arrow + 2, start).trim()) continue;
		let depth = 0;
		for (let index = start; index < body.length; index++) {
			if (body[index] === '{') depth++;
			else if (body[index] === '}' && --depth === 0) {
				ranges.push({ id: ranges.length, name: match[2], start, end: index });
				break;
			}
		}
	}
	return ranges;
}

const PATTERNS = [
	[/page\.goto\(\s*(['"`])(.*?)\1\s*\)/g, (m) => ({ action: 'goto', value: m[2] })],
	[
		/page\.locator\(\s*(['"`])(.*?)\1\s*\)\.click\(\s*\)/g,
		(m) => ({ action: 'click', selector: m[2] })
	],
	[
		/page\.locator\(\s*(['"`])(.*?)\1\s*\)\.fill\(\s*(['"`])(.*?)\3\s*\)/g,
		(m) => ({ action: 'fill', selector: m[2], value: m[4] })
	],
	[
		/page\.locator\(\s*(['"`])(.*?)\1\s*\)\.press\(\s*(['"`])(.*?)\3\s*\)/g,
		(m) => ({ action: 'press', selector: m[2], value: m[4] })
	],
	[
		/expect\(\s*page\.locator\(\s*(['"`])(.*?)\1\s*\)\s*\)\.toBeVisible\(\s*\)/g,
		(m) => ({ action: 'expectVisible', selector: m[2] })
	],
	[
		/expect\(\s*page\.locator\(\s*(['"`])(.*?)\1\s*\)\s*\)\.toContainText\(\s*(['"`])(.*?)\3\s*\)/g,
		(m) => ({ action: 'expectText', selector: m[2], value: m[4] })
	],
	[
		/saveElementScreenshot\(\s*page\s*,\s*(['"`])(.*?)\1\s*,\s*(['"`])(.*?)\3\s*\)/g,
		(m) => ({ action: 'screenshotElement', selector: m[2], path: m[4] })
	],
	[
		/saveScreenshot\(\s*page\s*,\s*(['"`])(.*?)\1\s*\)/g,
		(m) => ({ action: 'screenshotPage', path: m[2] })
	]
];

export function parseTestSteps(source, title) {
	const body = expandAliases(testBody(source, title));
	const ranges = groupRanges(body);
	const found = [];

	for (const [pattern, build] of PATTERNS) {
		for (const match of body.matchAll(pattern)) {
			const group = ranges
				.filter((range) => range.start < match.index && match.index < range.end)
				.sort((left, right) => left.start - right.start)
				.map((range) => ({ id: range.id, name: range.name }));
			found.push({
				index: match.index,
				step: {
					selector: '',
					value: '',
					path: '',
					...build(match),
					...(group.length ? { group } : {})
				}
			});
		}
	}

	found.sort((left, right) => left.index - right.index);

	const awaits = (body.match(/\bawait\b/g) ?? []).length;
	const wrappers = (body.match(/\bawait\s+test\.step\s*\(/g) ?? []).length;
	return {
		steps: found.map((entry) => entry.step),
		skipped: Math.max(0, awaits - found.length - wrappers)
	};
}
