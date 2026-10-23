import { EventEmitter } from 'node:events';
import {
	mkdtemp,
	readFile,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { installProcessErrorHandlers } from './process-errors';

const roots: string[] = [];
async function fixture() {
	const root = await mkdtemp(
		path.join(os.tmpdir(), 'rndevtools-process-errors-')
	);
	roots.push(root);
	const file = path.join(root, 'errors.log');
	const source = new EventEmitter();
	const exit = vi.fn();
	const dispose = installProcessErrorHandlers(
		{ logPath: () => file, exit },
		source
	);
	return { root, file, source, exit, dispose };
}
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
	);
});

it.each(['uncaughtException', 'unhandledRejection'])(
	'records %s privately before exiting once',
	async (event) => {
		const { file, source, exit, dispose } = await fixture();
		source.emit(event, new Error('password=example-secret person@example.com'));
		const text = await readFile(file, 'utf8');
		expect(text).toContain(event);
		expect(text).not.toContain('example-secret');
		expect(text).not.toContain('person@example.com');
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(exit).toHaveBeenCalledExactlyOnceWith(1);
		source.emit(event, new Error('a second failure'));
		expect(exit).toHaveBeenCalledTimes(1);
		dispose();
		expect(source.listenerCount(event)).toBe(0);
	}
);

it('bounds each error and resets a full log without retaining raw input', async () => {
	const { file, source } = await fixture();
	await writeFile(file, 'old'.repeat(30_000));
	source.emit('unhandledRejection', new Error('界'.repeat(100_000)));
	expect((await stat(file)).size).toBeLessThan(8192);
	expect(await readFile(file, 'utf8')).not.toContain('oldold');
});

it('still exits when logging fails and refuses to overwrite a symlink target', async () => {
	const { root, file, source, exit } = await fixture();
	const target = path.join(root, 'keep.txt');
	await writeFile(target, 'keep');
	await symlink(target, file);
	source.emit('uncaughtException', new Error('password=example-secret'));
	expect(await readFile(target, 'utf8')).toBe('keep');
	expect(exit).toHaveBeenCalledExactlyOnceWith(1);
});
