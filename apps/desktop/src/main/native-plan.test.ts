import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	createNativePlanRunner,
	nativePlanResultSchema,
	resolveProjectNode,
} from './native-plan';

describe('resolveProjectNode', () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'rndevtools-native-plan-'));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('prefers a Node pinned in the project tree, walking up through a workspace', () => {
		const app = path.join(root, 'apps', 'mobile');
		mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
		mkdirSync(app, { recursive: true });
		writeFileSync(
			path.join(root, 'node_modules', '.bin', 'node'),
			'#!/bin/sh\n'
		);
		expect(resolveProjectNode(app, { PATH: '/nowhere' })).toBe(
			path.join(root, 'node_modules', '.bin', 'node')
		);
	});

	it('falls back to the Node on the inherited PATH and never the Electron binary', () => {
		const bin = path.join(root, 'bin');
		mkdirSync(bin, { recursive: true });
		writeFileSync(path.join(bin, 'node'), '#!/bin/sh\n');
		expect(
			resolveProjectNode(root, { PATH: `/nowhere${path.delimiter}${bin}` })
		).toBe(path.join(bin, 'node'));
		expect(resolveProjectNode(root, { PATH: '/nowhere' })).toBeUndefined();
	});
});

describe('runNativePlan', () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(path.join(os.tmpdir(), 'rndevtools-native-plan-run-'));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	it('finds Node on the tool PATH and runs the plan with that PATH', async () => {
		const tools = path.join(root, 'tools');
		const project = path.join(root, 'app');
		mkdirSync(tools);
		mkdirSync(project);
		const seenPath = path.join(root, 'seen-path');
		const plan = {
			projectRoot: project,
			platform: 'ios',
			configuration: 'Debug',
			fingerprintHash: '78f81f7cf5a5717ebff99c9fbd6abf28831d1bf8',
			sourceCount: 3,
			cache: 'no-provider',
		};
		// Stands in for the user's Node: it records the PATH it was given and
		// prints what the in-project script would.
		writeFileSync(
			path.join(tools, 'node'),
			`#!/bin/sh\nprintf '%s' "$PATH" > '${seenPath}'\nprintf '%s' '${JSON.stringify(plan)}'\n`,
			{ mode: 0o755 }
		);
		const toolPath = `${tools}${path.delimiter}/usr/bin${path.delimiter}/bin`;
		const run = createNativePlanRunner({ toolPath: async () => toolPath });
		await expect(
			run({ projectRoot: project, platform: 'ios', configuration: 'Debug' })
		).resolves.toEqual(plan);
		expect(readFileSync(seenPath, 'utf8')).toBe(toolPath);
	});
});

describe('nativePlanResultSchema', () => {
	it('accepts what the in-project script emits and rejects a malformed fingerprint', () => {
		const result = nativePlanResultSchema.parse({
			projectRoot: '/Users/dev/app',
			platform: 'ios',
			configuration: 'Debug',
			fingerprintHash: '78f81f7cf5a5717ebff99c9fbd6abf28831d1bf8',
			sourceCount: 33,
			provider: {
				plugin: '@rndevtools/react-native/build-cache',
				cacheEntry:
					'/Users/dev/Library/Caches/rndevtools/native/ios/Debug/arm64-x/78f8',
			},
			cache: 'miss',
			bundleIdentifier: 'com.example.app',
			scheme: 'exampleapp',
		});
		expect(result.cache).toBe('miss');
		expect(() =>
			nativePlanResultSchema.parse({
				projectRoot: '/Users/dev/app',
				platform: 'ios',
				configuration: 'Debug',
				fingerprintHash: 'not-a-hash',
				sourceCount: 1,
				cache: 'no-provider',
			})
		).toThrow();
	});
});
