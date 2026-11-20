#!/usr/bin/env node
// Framework-agnostic Playwright harness: serves the UI and proxies your dev server,
// so the harness and the app share an origin and the iframe can be inspected.
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSpecFiles } from './specs.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Accepts `--app url`, `--app=url` and bare values, because `npm run harness --app url`
// makes npm eat the flag and pass the value positionally.
function parseArgs(argv) {
	const options = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg.startsWith('--')) {
			const [key, inline] = arg.slice(2).split('=');
			const next = inline ?? (argv[i + 1]?.startsWith('--') ? undefined : argv[++i]);
			if (next !== undefined) options[key] = next;
		} else if (/^https?:\/\//.test(arg)) {
			options.app = arg;
		} else if (/^\d+$/.test(arg)) {
			options.port = arg;
		}
	}
	return options;
}

const options = parseArgs(process.argv.slice(2));

const app = (options.app ?? 'http://localhost:5173').replace(/\/$/, '');
const port = Number(options.port ?? 5180);
const testsOption = (options.tests ?? 'tests').replaceAll('\\', '/').replace(/\/$/, '');
const tests = resolve(testsOption);

const TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png'
};

const server = createServer(async (req, res) => {
	const { pathname } = new URL(req.url, 'http://localhost');

	if (pathname === '/__harness/config') {
		res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify({ app, tests: testsOption }));
		return;
	}

	if (pathname === '/__harness/specs') {
		res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify(await readSpecFiles(tests)));
		return;
	}

	if (pathname === '/harness' || pathname === '/harness/') {
		return send(res, join(here, 'index.html'));
	}

	// harness assets sit next to this file; every other path belongs to the app
	const asset = resolve(here, `.${pathname}`);
	if (asset.startsWith(here) && existsSync(asset) && (await stat(asset)).isFile()) {
		return send(res, asset);
	}

	proxy(req, res);
});

// shortcut: no websocket upgrade handling, so the app's HMR socket will fail behind the proxy
function proxy(req, res) {
	const target = new URL(req.url, app);
	const upstream = request(
		{
			hostname: target.hostname,
			port: target.port,
			path: target.pathname + target.search,
			method: req.method,
			headers: { ...req.headers, host: target.host }
		},
		(response) => {
			res.writeHead(response.statusCode ?? 502, response.headers);
			response.pipe(res);
		}
	);
	upstream.on('error', () => {
		res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
		res.end(`Cannot reach ${app}. Start the app's dev server first.`);
	});
	req.pipe(upstream);
}

async function send(res, file) {
	res.writeHead(200, {
		'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
		'cache-control': 'no-store'
	});
	res.end(await readFile(file));
}

server.on('error', (error) => {
	console.error(
		error.code === 'EADDRINUSE'
			? `Port ${port} is in use. Pass --port <port> to use another one.`
			: error
	);
	process.exit(1);
});

server.listen(port, () => {
	console.log(`Harness:  http://localhost:${port}/harness`);
	console.log(`App:      ${app} (proxied)`);
	console.log(`Specs:    ${tests}`);
});
