import type { IpcMainInvokeEvent } from 'electron';
import { expect, it, vi } from 'vitest';
import { createUpdateIpcHandlers } from './update-ipc';
import { UpdateService } from './update-service';

it('allows only trusted renderers and the three fixed update operations', () => {
	const service = new UpdateService({
		currentVersion: '0.2.0',
		publish: vi.fn(),
		requestQuit: vi.fn(),
	});
	const assertTrustedRenderer = vi.fn();
	const handlers = createUpdateIpcHandlers(service, assertTrustedRenderer);
	const event = {} as IpcMainInvokeEvent;
	const run = vi.spyOn(service, 'run');
	for (const value of [
		'https://example.com/update.zip',
		{ operation: 'install' },
		'quit',
	])
		expect(() => handlers.runOperation(event, value)).toThrow();
	expect(run).not.toHaveBeenCalled();
	for (const operation of ['check', 'download', 'install'])
		handlers.runOperation(event, operation);
	expect(run).toHaveBeenCalledTimes(3);
	assertTrustedRenderer.mockImplementation(() => {
		throw new Error('Untrusted renderer');
	});
	expect(() => handlers.getState(event)).toThrow('Untrusted renderer');
	expect(() => handlers.runOperation(event, 'install')).toThrow(
		'Untrusted renderer'
	);
	expect(run).toHaveBeenCalledTimes(3);
});
