import assert from 'node:assert/strict';
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
	inspectHeroUiPayload,
	verifyHeroUiPayload,
} from './verify-heroui-pro.mjs';

const directories = [];
afterEach(() => {
	for (const dir of directories.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function fixture() {
	const dir = mkdtempSync(path.join(tmpdir(), 'rndevtools-license-integrity-'));
	directories.push(dir);
	mkdirSync(path.join(dir, 'dist'));
	writeFileSync(
		path.join(dir, 'package.json'),
		JSON.stringify({
			name: '@heroui-pro/react',
			version: '1.0.0-test',
			main: './dist/index.js',
		})
	);
	writeFileSync(path.join(dir, 'LICENSE'), 'Test fixture only');
	writeFileSync(
		path.join(dir, 'dist/index.js'),
		'export const fixture = true;'
	);
	return { dir, manifest: inspectHeroUiPayload(dir) };
}
test('accepts the exact reviewed payload without a credential', () => {
	const { dir, manifest } = fixture();
	assert.deepEqual(verifyHeroUiPayload(dir, manifest), manifest);
});
for (const mutation of ['changed', 'added', 'removed', 'metadata', 'symlink']) {
	test(`rejects ${mutation} payload content`, () => {
		const { dir, manifest } = fixture();
		const file = path.join(dir, 'dist/index.js');
		if (mutation === 'changed')
			writeFileSync(file, 'export const changed = true;');
		if (mutation === 'added')
			writeFileSync(path.join(dir, 'dist/extra.js'), 'export {};');
		if (mutation === 'removed' || mutation === 'symlink') rmSync(file);
		if (mutation === 'metadata')
			writeFileSync(
				path.join(dir, 'package.json'),
				JSON.stringify({
					name: '@heroui-pro/react',
					version: '1.0.0-test',
					main: './unreviewed.js',
				})
			);
		if (mutation === 'symlink') symlinkSync('../LICENSE', file);
		assert.throws(() => verifyHeroUiPayload(dir, manifest), /payload|hydrated/);
	});
}
test('refuses an unhydrated install stub', () => {
	const { dir, manifest } = fixture();
	rmSync(path.join(dir, 'dist'), { recursive: true });
	assert.throws(() => verifyHeroUiPayload(dir, manifest), /not hydrated/);
});
