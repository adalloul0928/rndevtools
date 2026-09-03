import {
	type DesktopDeviceAction,
	type DesktopDeviceInfoSnapshot,
	type DesktopDeviceToolsSnapshot,
	desktopActionCapability,
	PUMPD_DESKTOP_ACTION_CAPABILITIES,
	PUMPD_DESKTOP_PROTOCOL_VERSION,
	PUMPD_DESKTOP_SNAPSHOT_LIMITS,
	PUMPD_DESKTOP_TOOL_IDS,
	parseDesktopDeviceAction,
} from '@pumpd/devtools/desktop-protocol';
import { isSensitiveDiagnosticKey, redactDiagnosticText } from '@pumpd/devtools/redact';
import { z } from 'zod';

export const DESKTOP_PROTOCOL_VERSION = PUMPD_DESKTOP_PROTOCOL_VERSION;
export const DEFAULT_BROKER_HOST = '127.0.0.1';
export const DEFAULT_BROKER_PORT = 47931;

export { desktopActionCapability };

const SHORT_TEXT_MAX_LENGTH = 4 * 1024;
const LONG_TEXT_MAX_LENGTH = 512 * 1024;

/**
 * Redaction can lengthen text — `jwt:a` becomes `jwt:[REDACTED]` — so a value
 * that satisfied the raw bound can exceed it once transformed. Anything parsed
 * here is stored and later re-validated against this same schema by the preload
 * bridge, so an over-long transform output would make the broker's own state
 * unparseable and silently drop every later broadcast. Clamp after redacting so
 * the parsed value always satisfies the bound it was checked against.
 */
function redactWithinLength(value: string, maxLength: number): string {
	const redacted = redactDiagnosticText(value);
	if (redacted.length <= maxLength) return redacted;
	const clamped = redacted.slice(0, maxLength);
	const lastUnit = clamped.charCodeAt(maxLength - 1);
	// Never end on a high surrogate; that would leave a lone surrogate behind.
	return lastUnit >= 0xd800 && lastUnit <= 0xdbff ? clamped.slice(0, -1) : clamped;
}

const identifierSchema = z.string().trim().min(1).max(256);
const rawShortTextSchema = z.string().max(SHORT_TEXT_MAX_LENGTH);
const shortTextSchema = rawShortTextSchema.transform((value) =>
	redactWithinLength(value, SHORT_TEXT_MAX_LENGTH)
);
const rawLongTextSchema = z.string().max(LONG_TEXT_MAX_LENGTH);
const longTextSchema = rawLongTextSchema.transform((value) =>
	redactWithinLength(value, LONG_TEXT_MAX_LENGTH)
);
const timestampSchema = z.number().finite().nonnegative().max(8_640_000_000_000_000);
const optionalTextSchema = shortTextSchema.optional();
const headerRecordSchema = z
	.record(z.string().max(256), longTextSchema)
	.refine((headers) => Object.keys(headers).length <= 200, {
		message: 'Header maps cannot contain more than 200 fields.',
	})
	.transform((headers) => {
		const output = Object.create(null) as Record<string, string>;
		for (const [name, value] of Object.entries(headers)) {
			output[name] = isSensitiveDiagnosticKey(name) ? '[REDACTED]' : value;
		}
		return output;
	});

const toolIdSchema = z.enum(PUMPD_DESKTOP_TOOL_IDS);
export type ToolId = z.infer<typeof toolIdSchema>;

const devicePlatformSchema = z.enum(['ios', 'android', 'web', 'simulator', 'unknown']);
const deviceInfoObjectSchema = z.strictObject({
	id: identifierSchema,
	name: shortTextSchema,
	platform: devicePlatformSchema,
	model: shortTextSchema.optional(),
	osVersion: shortTextSchema.optional(),
	appVersion: shortTextSchema.optional(),
	buildVersion: shortTextSchema.optional(),
	runtimeVersion: shortTextSchema.optional(),
	variant: shortTextSchema.optional(),
	viewport: z
		.strictObject({
			width: z.number().finite().positive(),
			height: z.number().finite().positive(),
		})
		.optional(),
	capabilities: z
		.array(z.enum(PUMPD_DESKTOP_ACTION_CAPABILITIES))
		.max(PUMPD_DESKTOP_ACTION_CAPABILITIES.length)
		.default([]),
});
type DeviceInfoObject = z.infer<typeof deviceInfoObjectSchema>;
type ContractCompatibleDeviceInfo = DeviceInfoObject extends DesktopDeviceInfoSnapshot
	? DeviceInfoObject
	: never;
const deviceInfoSchema = deviceInfoObjectSchema.transform(
	(device: ContractCompatibleDeviceInfo) => device
);
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

const networkEntrySchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	method: z.string().trim().min(1).max(16),
	url: longTextSchema,
	host: shortTextSchema,
	path: longTextSchema,
	status: z.number().int().min(0).max(999).optional(),
	state: z.enum(['pending', 'success', 'error', 'aborted']),
	durationMs: z.number().finite().nonnegative().optional(),
	requestBytes: z.number().int().nonnegative().optional(),
	responseBytes: z.number().int().nonnegative().optional(),
	requestHeaders: headerRecordSchema.optional(),
	responseHeaders: headerRecordSchema.optional(),
	requestBody: longTextSchema.optional(),
	responseBody: longTextSchema.optional(),
	contentType: shortTextSchema.optional(),
	source: shortTextSchema.optional(),
	error: longTextSchema.optional(),
});
export type NetworkEntry = z.infer<typeof networkEntrySchema>;

const consoleEntrySchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	level: z.enum(['debug', 'info', 'warn', 'error']),
	message: longTextSchema,
	attributesText: longTextSchema.optional(),
	source: shortTextSchema.optional(),
});
export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;

const storageEntrySchema = z
	.strictObject({
		id: identifierSchema,
		adapterId: identifierSchema,
		adapterTitle: shortTextSchema,
		key: longTextSchema,
		valueText: rawLongTextSchema.optional(),
		valueType: z.enum(['string', 'number', 'boolean', 'json', 'binary', 'hidden']),
		bytes: z.number().int().nonnegative(),
		sensitive: z.boolean().default(false),
		editable: z.boolean().default(false),
		updatedAt: timestampSchema.optional(),
	})
	.transform((entry) => {
		const redactedValue =
			entry.valueText === undefined ? undefined : redactDiagnosticText(entry.valueText);
		const mustHide =
			entry.sensitive ||
			(entry.valueText !== undefined && redactedValue !== entry.valueText);
		if (mustHide) {
			const { valueText: _valueText, ...entryWithoutValue } = entry;
			return {
				...entryWithoutValue,
				valueType: 'hidden' as const,
				bytes: 0,
				sensitive: true,
				editable: false,
			};
		}
		return entry.valueText === undefined
			? entry
			: { ...entry, valueText: redactedValue };
	});
export type StorageEntry = z.infer<typeof storageEntrySchema>;

const storageEventSchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	adapterId: identifierSchema,
	key: longTextSchema,
	kind: z.enum(['added', 'updated', 'removed']),
	previousText: longTextSchema.optional(),
	nextText: longTextSchema.optional(),
});
const boundedCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const storageSummarySchema = z.strictObject({
	adapterCount: boundedCountSchema,
	totalKeyCount: boundedCountSchema,
	omittedKeyCount: boundedCountSchema,
	truncated: z.boolean(),
	errors: z
		.array(
			z.strictObject({
				adapterId: identifierSchema,
				adapterTitle: shortTextSchema,
				message: longTextSchema,
			})
		)
		.max(10),
});
const queryEntrySchema = z.strictObject({
	id: identifierSchema,
	hash: longTextSchema,
	keyText: longTextSchema,
	status: z.enum(['pending', 'success', 'error']),
	fetchStatus: z.enum(['idle', 'fetching', 'paused']),
	updatedAt: timestampSchema,
	observers: z.number().int().nonnegative(),
	isStale: z.boolean(),
	dataText: longTextSchema.optional(),
	errorText: longTextSchema.optional(),
	truncated: z.boolean().default(false),
});
export type QueryEntry = z.infer<typeof queryEntrySchema>;

const mutationEntrySchema = z.strictObject({
	id: identifierSchema,
	keyText: longTextSchema,
	status: z.enum(['idle', 'pending', 'success', 'error']),
	submittedAt: timestampSchema.optional(),
	variablesText: longTextSchema.optional(),
	errorText: longTextSchema.optional(),
	truncated: z.boolean().default(false),
});
const querySummarySchema = z.strictObject({
	sourceQueryCount: boundedCountSchema,
	omittedQueryCount: boundedCountSchema,
	sourceMutationCount: boundedCountSchema,
	omittedMutationCount: boundedCountSchema,
	truncated: z.boolean(),
});
const routeEntrySchema = z.strictObject({
	id: identifierSchema,
	path: longTextSchema,
	name: shortTextSchema,
	kind: z.enum(['static', 'dynamic', 'catchAll', 'layout', 'group', 'internal']),
	filename: longTextSchema.optional(),
	isCurrent: z.boolean().default(false),
	isVisible: z.boolean().default(false),
	depth: z.number().int().nonnegative().default(0),
});
export type RouteEntry = z.infer<typeof routeEntrySchema>;

const routeEventSchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	route: longTextSchema,
	metadataText: longTextSchema.optional(),
});
const environmentEntrySchema = z
	.strictObject({
		id: identifierSchema,
		section: shortTextSchema,
		key: shortTextSchema,
		valueText: longTextSchema,
		status: z.enum(['valid', 'missing', 'typeMismatch', 'valueMismatch', 'unchecked']),
		description: longTextSchema.optional(),
	})
	.transform((entry) =>
		isSensitiveDiagnosticKey(entry.key) ? { ...entry, valueText: '[REDACTED]' } : entry
	);
export type EnvironmentEntry = z.infer<typeof environmentEntrySchema>;

const zustandStoreSchema = z.strictObject({
	id: identifierSchema,
	title: shortTextSchema,
	description: optionalTextSchema,
	stateText: longTextSchema,
	keys: z.array(shortTextSchema).max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.storageKeys),
	updatedAt: timestampSchema,
	error: longTextSchema.optional(),
});
const zustandChangeSchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	storeId: identifierSchema,
	storeTitle: shortTextSchema,
	changedKeys: z
		.array(shortTextSchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.zustandChangedKeys),
	stateText: longTextSchema,
	error: longTextSchema.optional(),
});
const zustandSummarySchema = z.strictObject({
	totalStoreCount: boundedCountSchema,
	omittedStoreCount: boundedCountSchema,
	truncated: z.boolean(),
	error: longTextSchema.optional(),
});
const restoreSourceSchema = z.strictObject({
	id: identifierSchema,
	title: shortTextSchema,
	preview: longTextSchema,
	bytes: z.number().int().nonnegative(),
});
const restorePointSchema = z.strictObject({
	id: identifierSchema,
	label: shortTextSchema,
	createdAt: timestampSchema,
	estimatedBytes: z.number().int().nonnegative(),
	sources: z
		.array(restoreSourceSchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.restoreSources),
});
const performanceSampleSchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	jsFps: z.number().finite().min(0).max(240),
	uiFps: z.number().finite().min(0).max(240).optional(),
	cpuPercent: z.number().finite().min(0).max(100).optional(),
	memoryMb: z.number().finite().nonnegative().optional(),
	eventLoopLagMs: z.number().finite().nonnegative(),
	longFrames: z.number().int().nonnegative(),
	maxFrameMs: z.number().finite().nonnegative(),
	route: longTextSchema.optional(),
});
export type PerformanceSample = z.infer<typeof performanceSampleSchema>;

const performanceSummarySchema = z.strictObject({
	grade: z.enum(['idle', 'healthy', 'needsAttention', 'critical']),
	durationMs: z.number().finite().nonnegative(),
	sampleCount: z.number().int().nonnegative(),
	averageJsFps: z.number().finite().nonnegative(),
	averageUiFps: z.number().finite().nonnegative().optional(),
	averageEventLoopLagMs: z.number().finite().nonnegative(),
	p95EventLoopLagMs: z.number().finite().nonnegative(),
	maxEventLoopLagMs: z.number().finite().nonnegative(),
	longFrameCount: z.number().int().nonnegative(),
});
const performanceReviewSchema = z.strictObject({
	isActive: z.boolean(),
	startedAt: timestampSchema.nullable(),
	stoppedAt: timestampSchema.nullable(),
	error: longTextSchema.optional(),
	droppedSampleCount: boundedCountSchema.default(0),
	samples: z
		.array(performanceSampleSchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.performanceSamples),
	summary: performanceSummarySchema,
});
export type PerformanceReview = z.infer<typeof performanceReviewSchema>;

const componentTargetSchema = z.strictObject({
	id: identifierSchema,
	name: shortTextSchema,
	kind: shortTextSchema,
	feature: optionalTextSchema,
	route: longTextSchema.optional(),
	testID: optionalTextSchema,
	targetKey: optionalTextSchema,
	sourceFiles: z
		.array(longTextSchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.componentSourceFiles),
	instanceText: longTextSchema.optional(),
	instanceTruncated: z.boolean().default(false),
	bounds: z
		.strictObject({
			x: z.number().finite(),
			y: z.number().finite(),
			width: z.number().finite().nonnegative(),
			height: z.number().finite().nonnegative(),
		})
		.nullable(),
	isFocused: z.boolean(),
});
export type ComponentTarget = z.infer<typeof componentTargetSchema>;

const componentSummarySchema = z.strictObject({
	sourceTargetCount: boundedCountSchema,
	omittedTargetCount: boundedCountSchema,
	truncated: z.boolean(),
	error: longTextSchema.optional(),
});
const diagnosticEntrySchema = z.strictObject({
	id: identifierSchema,
	at: timestampSchema,
	level: z.enum(['debug', 'info', 'warn', 'error']),
	scope: shortTextSchema,
	message: longTextSchema,
});
export type DiagnosticEntry = z.infer<typeof diagnosticEntrySchema>;

const deviceToolsObjectSchema = z.strictObject({
	network: z.array(networkEntrySchema).max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.network),
	console: z.array(consoleEntrySchema).max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.console),
	storage: z.array(storageEntrySchema).max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.storage),
	storageEvents: z
		.array(storageEventSchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.storageEvents),
	storageSummary: storageSummarySchema,
	queries: z.array(queryEntrySchema).max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.queries),
	mutations: z.array(mutationEntrySchema).max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.mutations),
	querySummary: querySummarySchema,
	routes: z.array(routeEntrySchema).max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.routes),
	routeEvents: z.array(routeEventSchema).max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.routeEvents),
	environment: z
		.array(environmentEntrySchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.environment),
	zustandStores: z
		.array(zustandStoreSchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.zustandStores),
	zustandChanges: z
		.array(zustandChangeSchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.zustandChanges),
	zustandSummary: zustandSummarySchema,
	restorePoints: z
		.array(restorePointSchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.restorePoints),
	performance: performanceReviewSchema,
	components: z
		.array(componentTargetSchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.components),
	componentSummary: componentSummarySchema,
	diagnostics: z
		.array(diagnosticEntrySchema)
		.max(PUMPD_DESKTOP_SNAPSHOT_LIMITS.diagnostics),
});

type DeviceToolsObject = z.infer<typeof deviceToolsObjectSchema>;
type ContractCompatibleDeviceTools =
	DeviceToolsObject extends DesktopDeviceToolsSnapshot ? DeviceToolsObject : never;

function scrubSensitiveStorage(
	tools: ContractCompatibleDeviceTools
): DeviceToolsObject {
	const sensitiveAdapterIds = new Set(
		tools.storage.filter((entry) => entry.sensitive).map((entry) => entry.adapterId)
	);
	return {
		...tools,
		storage: tools.storage.map((entry) => {
			if (!entry.sensitive) return entry;
			const { valueText: _valueText, ...entryWithoutValue } = entry;
			return {
				...entryWithoutValue,
				bytes: 0,
				editable: false,
			};
		}),
		storageEvents: tools.storageEvents.map((event) =>
			sensitiveAdapterIds.has(event.adapterId)
				? { ...event, previousText: undefined, nextText: undefined }
				: event
		),
	};
}

const deviceToolsSchema = deviceToolsObjectSchema.transform(scrubSensitiveStorage);
export type DeviceTools = z.infer<typeof deviceToolsSchema>;

export function createEmptyDeviceTools(): DeviceTools {
	return {
		network: [],
		console: [],
		storage: [],
		storageEvents: [],
		storageSummary: {
			adapterCount: 0,
			totalKeyCount: 0,
			omittedKeyCount: 0,
			truncated: false,
			errors: [],
		},
		queries: [],
		mutations: [],
		querySummary: {
			sourceQueryCount: 0,
			omittedQueryCount: 0,
			sourceMutationCount: 0,
			omittedMutationCount: 0,
			truncated: false,
		},
		routes: [],
		routeEvents: [],
		environment: [],
		zustandStores: [],
		zustandChanges: [],
		zustandSummary: {
			totalStoreCount: 0,
			omittedStoreCount: 0,
			truncated: false,
		},
		restorePoints: [],
		performance: {
			isActive: false,
			startedAt: null,
			stoppedAt: null,
			droppedSampleCount: 0,
			samples: [],
			summary: {
				grade: 'idle',
				durationMs: 0,
				sampleCount: 0,
				averageJsFps: 0,
				averageEventLoopLagMs: 0,
				p95EventLoopLagMs: 0,
				maxEventLoopLagMs: 0,
				longFrameCount: 0,
			},
		},
		components: [],
		componentSummary: {
			sourceTargetCount: 0,
			omittedTargetCount: 0,
			truncated: false,
		},
		diagnostics: [],
	};
}

const deviceSessionSchema = z.strictObject({
	info: deviceInfoSchema,
	status: z.enum(['online', 'offline', 'simulated']),
	connectedAt: timestampSchema,
	lastSeenAt: timestampSchema,
	sequence: z.number().int().nonnegative(),
	latencyMs: z.number().finite().nonnegative().optional(),
	tools: deviceToolsSchema,
});
export type DeviceSession = z.infer<typeof deviceSessionSchema>;

const brokerInfoSchema = z.strictObject({
	status: z.enum(['starting', 'listening', 'error', 'stopped']),
	host: shortTextSchema,
	port: z.number().int().min(1).max(65_535),
	access: z.enum(['loopback', 'token']),
	// Pairing URLs intentionally retain the broker token so the operator can
	// copy them to a device. They are never logged by the desktop client.
	urls: z.array(rawShortTextSchema).max(50),
	error: longTextSchema.optional(),
});
export const desktopStateSchema = z.strictObject({
	protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
	broker: brokerInfoSchema,
	devices: z.array(deviceSessionSchema).max(50),
	diagnostics: z.array(diagnosticEntrySchema).max(2_000),
});
export type DesktopState = z.infer<typeof desktopStateSchema>;

export const deviceHelloMessageSchema = z.strictObject({
	type: z.literal('hello'),
	protocolVersion: z.literal(DESKTOP_PROTOCOL_VERSION),
	device: deviceInfoSchema,
});

export const deviceSnapshotMessageSchema = z.strictObject({
	type: z.literal('snapshot'),
	sequence: z.number().int().nonnegative(),
	sentAt: timestampSchema,
	tools: deviceToolsSchema,
});

const deviceHeartbeatMessageSchema = z.strictObject({
	type: z.literal('heartbeat'),
	sentAt: timestampSchema,
});

const deviceActionResultMessageSchema = z.strictObject({
	type: z.literal('action-result'),
	actionId: identifierSchema,
	ok: z.boolean(),
	error: longTextSchema.optional(),
});

export const deviceMessageSchema = z.discriminatedUnion('type', [
	deviceHelloMessageSchema,
	deviceSnapshotMessageSchema,
	deviceHeartbeatMessageSchema,
	deviceActionResultMessageSchema,
]);
export type DeviceMessage = z.infer<typeof deviceMessageSchema>;

export const desktopActionSchema = z.unknown().transform((value, context) => {
	const action = parseDesktopDeviceAction(value);
	if (action) return action;
	context.addIssue({
		code: 'custom',
		message: 'Desktop action is not on the explicit command allowlist.',
	});
	return z.NEVER;
});
export type DesktopAction = DesktopDeviceAction;

export const desktopActionResultSchema = z.strictObject({
	actionId: identifierSchema,
	ok: z.boolean(),
	error: longTextSchema.optional(),
});
export type DesktopActionResult = z.infer<typeof desktopActionResultSchema>;

const desktopPlatformSchema = z.enum([
	'aix',
	'android',
	'browser',
	'cygwin',
	'darwin',
	'freebsd',
	'haiku',
	'linux',
	'netbsd',
	'openbsd',
	'sunos',
	'win32',
]);

export const desktopBootstrapSchema = z.strictObject({
	state: desktopStateSchema,
	platform: desktopPlatformSchema,
	versions: z.strictObject({
		app: shortTextSchema,
		electron: shortTextSchema,
		chrome: shortTextSchema,
		node: shortTextSchema,
	}),
});
export type DesktopBootstrap = z.infer<typeof desktopBootstrapSchema>;

export type DesktopBridge = {
	getBootstrap: () => Promise<DesktopBootstrap>;
	subscribe: (listener: (state: DesktopState) => void) => () => void;
	runAction: (action: DesktopAction) => Promise<DesktopActionResult>;
};
