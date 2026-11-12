/**
 * Fork guard: every API endpoint the frontend calls must be reviewed for
 * namespace scoping.
 *
 * namespaceScope.endpoints.json records, for each endpoint, how it is scoped
 * (or "unscoped" when it carries no telemetry / no namespace concept). When an
 * upstream release adds or changes an endpoint, this test fails and lists it,
 * so new pages can't silently show data from every namespace.
 *
 * After reviewing (and, if needed, adding a rule to utils/namespaceScope.ts):
 *   UPDATE_SCOPE_MANIFEST=1 pnpm jest src/utils/__tests__/namespaceScopeCoverage
 */
import fs from 'fs';
import path from 'path';
import { describeScope } from 'utils/namespaceScope';

const SRC = path.resolve(__dirname, '..', '..');
const API_DIR = path.join(SRC, 'api');
const MANIFEST = path.join(SRC, 'utils', 'namespaceScope.endpoints.json');

function walk(dir: string): string[] {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			return entry.name === '__tests__' ? [] : walk(full);
		}
		return /\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)
			? [full]
			: [];
	});
}

const normalise = (url: string): string =>
	url
		.replace(/\$\{[^}]*\}/g, '{}')
		.split('?')[0]
		.replace(/\/+$/, '');

function discoverEndpoints(): Record<string, string> {
	const found: Record<string, string> = {};
	walk(API_DIR).forEach((file) => {
		const text = fs.readFileSync(file, 'utf8');
		// orval-generated clients: url: `/api/...`, method: 'GET'
		const generated = /url:\s*`([^`]+)`,\s*method:\s*'([A-Z]+)'/g;
		let match = generated.exec(text);
		while (match) {
			found[`${match[2]} ${normalise(match[1])}`] = '';
			match = generated.exec(text);
		}
		// hand-written clients: <instance>.post('/path' ...
		const manual =
			/\.(get|post|put|patch|delete)(?:<[^>(]*>)?\(\s*[`'"]([^`'"]+)[`'"]/g;
		match = manual.exec(text);
		while (match) {
			const url = normalise(match[2]);
			if (url && !url.startsWith('http')) {
				found[`${match[1].toUpperCase()} ${url}`] = '';
			}
			match = manual.exec(text);
		}
	});
	Object.keys(found).forEach((key) => {
		const [method, url] = key.split(' ');
		found[key] = describeScope(method, url) ?? 'unscoped';
	});
	return Object.fromEntries(
		Object.entries(found).sort(([a], [b]) => a.localeCompare(b)),
	);
}

describe('namespace scope endpoint coverage', () => {
	it('every API endpoint has been reviewed for namespace scoping', () => {
		const current = discoverEndpoints();

		if (process.env.UPDATE_SCOPE_MANIFEST) {
			fs.writeFileSync(MANIFEST, `${JSON.stringify(current, null, '\t')}\n`);
			return;
		}

		const reviewed: Record<string, string> = JSON.parse(
			fs.readFileSync(MANIFEST, 'utf8'),
		);
		const added = Object.keys(current).filter((k) => !(k in reviewed));
		const changed = Object.keys(current).filter(
			(k) => k in reviewed && reviewed[k] !== current[k],
		);

		const problems = [
			...added.map((k) => `NEW      ${k}  (currently: ${current[k]})`),
			...changed.map((k) => `CHANGED  ${k}  (${reviewed[k]} -> ${current[k]})`),
		];
		if (problems.length) {
			throw new Error(
				`Endpoints not reviewed for namespace scoping:\n  ${problems.join(
					'\n  ',
				)}\n\nReview them in utils/namespaceScope.ts, then run with UPDATE_SCOPE_MANIFEST=1.`,
			);
		}
	});
});
