import { describe, expect, it } from 'vitest';
import { createDemoDevice } from './demo-data';
import {
	createEmptyDeviceTools,
	DESKTOP_PROTOCOL_VERSION,
	desktopBootstrapSchema,
	deviceHelloMessageSchema,
	deviceSnapshotMessageSchema,
} from './protocol';

describe('redaction stays inside the advertised text bounds', () => {
	it('re-parses its own output when redaction expands the text', () => {
		// Redaction lengthens text (`jwt:a` -> `jwt:[REDACTED]`), and Zod applies
		// `.max()` before the transform. Whatever this schema produces is stored by
		// the broker and re-validated by the preload bridge, so an over-long
		// transform output would make the broker's own state unparseable and
		// silently drop every later renderer broadcast.
		const hello = {
			type: 'hello' as const,
			protocolVersion: DESKTOP_PROTOCOL_VERSION,
			device: {
				id: 'device-1',
				name: 'jwt:a,'.repeat(682),
				platform: 'ios' as const,
			},
		};
		const parsed = deviceHelloMessageSchema.parse(hello);
		expect(parsed.device.name).toContain('[REDACTED]');
		expect(parsed.device.name.length).toBeLessThanOrEqual(4 * 1024);
		// The parsed value must itself satisfy the schema it came from.
		expect(() =>
			deviceHelloMessageSchema.parse({ ...hello, device: parsed.device })
		).not.toThrow();
	});
});

describe('desktop IPC and device schemas', () => {
	it('accepts the complete browser-preview bootstrap', () => {
		expect(
			desktopBootstrapSchema.parse({
				state: {
					protocolVersion: DESKTOP_PROTOCOL_VERSION,
					broker: {
						status: 'listening',
						host: '127.0.0.1',
						port: 47931,
						access: 'loopback',
						urls: ['ws://127.0.0.1:47931/device'],
					},
					devices: [createDemoDevice()],
					diagnostics: [],
				},
				platform: 'browser',
				versions: {
					app: '0.1.0',
					electron: 'browser preview',
					chrome: 'test',
					node: 'not available',
				},
			})
		).toMatchObject({ platform: 'browser' });
	});

	it('rejects unadvertised capability names', () => {
		expect(() =>
			deviceHelloMessageSchema.parse({
				type: 'hello',
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				device: {
					id: 'device',
					name: 'Device',
					platform: 'ios',
					capabilities: ['runtime.evaluate'],
				},
			})
		).toThrow();
	});

	it('bounds network header maps before they enter broker state', () => {
		const requestHeaders = Object.fromEntries(
			Array.from({ length: 201 }, (_, index) => [`x-test-${index}`, 'value'])
		);
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 1,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					network: [
						{
							id: 'request',
							at: Date.now(),
							method: 'GET',
							url: 'https://example.test',
							host: 'example.test',
							path: '/',
							state: 'success',
							requestHeaders,
						},
					],
				},
			})
		).toThrow('Header maps');
	});

	it('redacts headers and environment values using their sensitive field names', () => {
		const parsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: {
				...createEmptyDeviceTools(),
				network: [
					{
						id: 'request',
						at: Date.now(),
						method: 'GET',
						url: 'https://example.test',
						host: 'example.test',
						path: '/',
						state: 'success',
						requestHeaders: {
							Authorization: 'Basic opaque-credential',
							'X-API-Key': 'opaque-api-key',
							Accept: 'application/json',
						},
					},
				],
				environment: [
					{
						id: 'environment-token',
						section: 'Runtime',
						key: 'API_TOKEN',
						valueText: 'opaque-environment-credential',
						status: 'valid',
					},
				],
			},
		});

		expect(parsed.tools.network[0]?.requestHeaders).toEqual({
			Accept: 'application/json',
			Authorization: '[REDACTED]',
			'X-API-Key': '[REDACTED]',
		});
		expect(parsed.tools.environment[0]?.valueText).toBe('[REDACTED]');
	});

	it('rejects timestamps outside the JavaScript Date range', () => {
		const tools = createDemoDevice().tools;
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 1,
				sentAt: Number.MAX_VALUE,
				tools,
			})
		).toThrow();
	});

	it('requires snapshots to contain every tool projection', () => {
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 1,
				sentAt: Date.now(),
				tools: { network: [] },
			})
		).toThrow();
	});

	it('rejects unknown fields inside wire entries', () => {
		expect(() =>
			deviceSnapshotMessageSchema.parse({
				type: 'snapshot',
				sequence: 1,
				sentAt: Date.now(),
				tools: {
					...createEmptyDeviceTools(),
					console: [
						{
							id: 'log',
							at: Date.now(),
							level: 'info',
							message: 'hello',
							unexpected: 'not allowed',
						},
					],
				},
			})
		).toThrow();
	});

	it('scrubs values and size metadata from sensitive storage entries', () => {
		const parsed = deviceSnapshotMessageSchema.parse({
			type: 'snapshot',
			sequence: 1,
			sentAt: Date.now(),
			tools: {
				...createEmptyDeviceTools(),
				storage: [
					{
						id: 'secret-entry',
						adapterId: 'secure',
						adapterTitle: 'Secure storage',
						key: 'auth.token',
						valueText: 'must-not-cross-the-boundary',
						valueType: 'hidden',
						bytes: 128,
						sensitive: true,
						editable: true,
					},
					{
						id: 'misclassified-entry',
						adapterId: 'standard',
						adapterTitle: 'Standard storage',
						key: 'legacy.value',
						valueText: 'token=unexpected-secret',
						valueType: 'string',
						bytes: 23,
						sensitive: false,
						editable: true,
					},
				],
				storageEvents: [
					{
						id: 'secret-event',
						at: Date.now(),
						adapterId: 'secure',
						key: 'auth.token',
						kind: 'updated',
						previousText: 'before-secret',
						nextText: 'after-secret',
					},
				],
			},
		});

		expect(parsed.tools.storage?.[0]).toMatchObject({
			bytes: 0,
			sensitive: true,
			editable: false,
		});
		expect(parsed.tools.storage?.[0]?.valueText).toBeUndefined();
		expect(parsed.tools.storage?.[1]).toMatchObject({
			valueType: 'hidden',
			bytes: 0,
			sensitive: true,
			editable: false,
		});
		expect(parsed.tools.storage?.[1]?.valueText).toBeUndefined();
		expect(parsed.tools.storageEvents?.[0]?.previousText).toBeUndefined();
		expect(parsed.tools.storageEvents?.[0]?.nextText).toBeUndefined();
	});

	it('redacts diagnostic strings while preserving explicit pairing URLs', () => {
		const parsed = desktopBootstrapSchema.parse({
			state: {
				protocolVersion: DESKTOP_PROTOCOL_VERSION,
				broker: {
					status: 'listening',
					host: '0.0.0.0',
					port: 47931,
					access: 'token',
					urls: ['ws://192.168.1.10:47931/device?token=pairing-secret'],
				},
				devices: [],
				diagnostics: [
					{
						id: 'diagnostic',
						at: Date.now(),
						level: 'warn',
						scope: 'test',
						message: '{"token":"device-secret"}',
					},
				],
			},
			platform: 'browser',
			versions: {
				app: '0.1.0',
				electron: 'test',
				chrome: 'test',
				node: 'test',
			},
		});

		expect(parsed.state.diagnostics[0]?.message).toBe('{"token":"[REDACTED]"}');
		expect(parsed.state.broker.urls[0]).toContain('token=pairing-secret');
	});
});
