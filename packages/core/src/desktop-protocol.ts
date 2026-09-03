import { utf8ByteLength } from './core/serialize';

export const PUMPD_DESKTOP_PROTOCOL_VERSION = 1 as const;

export const PUMPD_DESKTOP_TOOL_IDS = [
	'network',
	'console',
	'storage',
	'query',
	'routes',
	'environment',
	'zustand',
	'restore',
	'performance',
	'components',
	'diagnostics',
] as const;

export type DesktopToolId = (typeof PUMPD_DESKTOP_TOOL_IDS)[number];

/**
 * The maximum number of rows the desktop boundary accepts per collection.
 *
 * These bounds used to exist twice — as `.max()` on the desktop Zod schemas and
 * as hand-written numbers in the mobile projector — with nothing linking them.
 * The shared DTO types every array as unbounded, so the compile-time contract
 * check cannot see a mismatch: raising a producer cap past its consumer bound
 * typechecks, lints and tests clean, then rejects the *entire* multi-tool
 * snapshot at the broker and leaves the device reconnecting in a loop.
 *
 * Both sides now read this table, so they cannot drift apart.
 */
export const PUMPD_DESKTOP_SNAPSHOT_LIMITS = {
	network: 2_000,
	console: 5_000,
	storage: 5_000,
	storageEvents: 2_000,
	storageKeys: 500,
	queries: 2_000,
	mutations: 2_000,
	routes: 5_000,
	routeEvents: 2_000,
	environment: 2_000,
	zustandStores: 500,
	zustandChanges: 2_000,
	zustandChangedKeys: 500,
	restorePoints: 100,
	restoreSources: 50,
	components: 2_000,
	componentSourceFiles: 20,
	performanceSamples: 1_500,
	diagnostics: 2_000,
} as const;

export type DesktopSnapshotLimit = keyof typeof PUMPD_DESKTOP_SNAPSHOT_LIMITS;

/**
 * Every remotely invokable operation has one capability with the same
 * `tool.command` spelling. Read-only tools intentionally have no capability.
 */
export const PUMPD_DESKTOP_ACTION_CAPABILITIES = [
	'network.clear',
	'console.clear',
	'storage.write',
	'query.refetch',
	'query.invalidate',
	'routes.navigate',
	'zustand.refresh',
	'restore.capture',
	'restore.restore',
	'restore.remove',
	'performance.review',
	'components.refresh',
	'components.highlight',
] as const;

export type DesktopActionCapability =
	(typeof PUMPD_DESKTOP_ACTION_CAPABILITIES)[number];

export type DesktopDeviceAction = {
	actionId: string;
	deviceId: string;
	tool: DesktopToolId;
	command: string;
	payload: Record<string, unknown>;
};

export type DesktopDeviceInfoSnapshot = {
	id: string;
	name: string;
	platform: 'ios' | 'android' | 'web' | 'simulator' | 'unknown';
	model?: string | undefined;
	osVersion?: string | undefined;
	appVersion?: string | undefined;
	buildVersion?: string | undefined;
	runtimeVersion?: string | undefined;
	variant?: string | undefined;
	viewport?: { width: number; height: number } | undefined;
	capabilities: readonly DesktopActionCapability[];
};

type DesktopNetworkSnapshot = {
	id: string;
	at: number;
	method: string;
	url: string;
	host: string;
	path: string;
	status?: number | undefined;
	state: 'pending' | 'success' | 'error' | 'aborted';
	durationMs?: number | undefined;
	requestBytes?: number | undefined;
	responseBytes?: number | undefined;
	requestHeaders?: Readonly<Record<string, string>> | undefined;
	responseHeaders?: Readonly<Record<string, string>> | undefined;
	requestBody?: string | undefined;
	responseBody?: string | undefined;
	contentType?: string | undefined;
	source?: string | undefined;
	error?: string | undefined;
};

type DesktopConsoleSnapshot = {
	id: string;
	at: number;
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	attributesText?: string | undefined;
	source?: string | undefined;
};

type DesktopStorageSnapshot = {
	id: string;
	adapterId: string;
	adapterTitle: string;
	key: string;
	valueText?: string | undefined;
	valueType: 'string' | 'number' | 'boolean' | 'json' | 'binary' | 'hidden';
	bytes: number;
	sensitive: boolean;
	editable: boolean;
	updatedAt?: number | undefined;
};

type DesktopStorageEventSnapshot = {
	id: string;
	at: number;
	adapterId: string;
	key: string;
	kind: 'added' | 'updated' | 'removed';
	previousText?: string | undefined;
	nextText?: string | undefined;
};

type DesktopQuerySnapshot = {
	id: string;
	hash: string;
	keyText: string;
	status: 'pending' | 'success' | 'error';
	fetchStatus: 'idle' | 'fetching' | 'paused';
	updatedAt: number;
	observers: number;
	isStale: boolean;
	dataText?: string | undefined;
	errorText?: string | undefined;
	truncated: boolean;
};

type DesktopMutationSnapshot = {
	id: string;
	keyText: string;
	status: 'idle' | 'pending' | 'success' | 'error';
	submittedAt?: number | undefined;
	variablesText?: string | undefined;
	errorText?: string | undefined;
	truncated: boolean;
};

type DesktopRouteSnapshot = {
	id: string;
	path: string;
	name: string;
	kind: 'static' | 'dynamic' | 'catchAll' | 'layout' | 'group' | 'internal';
	filename?: string | undefined;
	isCurrent: boolean;
	isVisible: boolean;
	depth: number;
};

type DesktopEnvironmentSnapshot = {
	id: string;
	section: string;
	key: string;
	valueText: string;
	status: 'valid' | 'missing' | 'typeMismatch' | 'valueMismatch' | 'unchecked';
	description?: string | undefined;
};

type DesktopPerformanceSampleSnapshot = {
	id: string;
	at: number;
	jsFps: number;
	uiFps?: number | undefined;
	cpuPercent?: number | undefined;
	memoryMb?: number | undefined;
	eventLoopLagMs: number;
	longFrames: number;
	maxFrameMs: number;
	route?: string | undefined;
};

type DesktopDiagnosticSnapshot = {
	id: string;
	at: number;
	level: 'debug' | 'info' | 'warn' | 'error';
	scope: string;
	message: string;
};

/**
 * Versioned mobile-to-desktop snapshot DTO. Both the mobile projector and the
 * desktop Zod boundary compile against this contract so protocol drift fails
 * type checking before a device can connect.
 */
export type DesktopDeviceToolsSnapshot = {
	network: readonly DesktopNetworkSnapshot[];
	console: readonly DesktopConsoleSnapshot[];
	storage: readonly DesktopStorageSnapshot[];
	storageEvents: readonly DesktopStorageEventSnapshot[];
	storageSummary: {
		adapterCount: number;
		totalKeyCount: number;
		omittedKeyCount: number;
		truncated: boolean;
		errors: readonly {
			adapterId: string;
			adapterTitle: string;
			message: string;
		}[];
	};
	queries: readonly DesktopQuerySnapshot[];
	mutations: readonly DesktopMutationSnapshot[];
	querySummary: {
		sourceQueryCount: number;
		omittedQueryCount: number;
		sourceMutationCount: number;
		omittedMutationCount: number;
		truncated: boolean;
	};
	routes: readonly DesktopRouteSnapshot[];
	routeEvents: readonly {
		id: string;
		at: number;
		route: string;
		metadataText?: string | undefined;
	}[];
	environment: readonly DesktopEnvironmentSnapshot[];
	zustandStores: readonly {
		id: string;
		title: string;
		description?: string | undefined;
		stateText: string;
		keys: readonly string[];
		updatedAt: number;
		error?: string | undefined;
	}[];
	zustandChanges: readonly {
		id: string;
		at: number;
		storeId: string;
		storeTitle: string;
		changedKeys: readonly string[];
		stateText: string;
		error?: string | undefined;
	}[];
	zustandSummary: {
		totalStoreCount: number;
		omittedStoreCount: number;
		truncated: boolean;
		error?: string | undefined;
	};
	restorePoints: readonly {
		id: string;
		label: string;
		createdAt: number;
		estimatedBytes: number;
		sources: readonly {
			id: string;
			title: string;
			preview: string;
			bytes: number;
		}[];
	}[];
	performance: {
		isActive: boolean;
		startedAt: number | null;
		stoppedAt: number | null;
		error?: string | undefined;
		droppedSampleCount: number;
		samples: readonly DesktopPerformanceSampleSnapshot[];
		summary: {
			grade: 'idle' | 'healthy' | 'needsAttention' | 'critical';
			durationMs: number;
			sampleCount: number;
			averageJsFps: number;
			averageUiFps?: number | undefined;
			averageEventLoopLagMs: number;
			p95EventLoopLagMs: number;
			maxEventLoopLagMs: number;
			longFrameCount: number;
		};
	};
	components: readonly {
		id: string;
		name: string;
		kind: string;
		feature?: string | undefined;
		route?: string | undefined;
		testID?: string | undefined;
		targetKey?: string | undefined;
		sourceFiles: readonly string[];
		instanceText?: string | undefined;
		instanceTruncated: boolean;
		bounds: {
			x: number;
			y: number;
			width: number;
			height: number;
		} | null;
		isFocused: boolean;
	}[];
	componentSummary: {
		sourceTargetCount: number;
		omittedTargetCount: number;
		truncated: boolean;
		error?: string | undefined;
	};
	diagnostics: readonly DesktopDiagnosticSnapshot[];
};

const toolIds = new Set<string>(PUMPD_DESKTOP_TOOL_IDS);
const actionCapabilities = new Set<string>(PUMPD_DESKTOP_ACTION_CAPABILITIES);

const MAX_IDENTIFIER_BYTES = 256;
const MAX_COMMAND_BYTES = 128;
const MAX_SHORT_TEXT_BYTES = 4 * 1024;
const MAX_LONG_TEXT_BYTES = 512 * 1024;

function dataRecord(value: unknown): Record<string, unknown> | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	try {
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) return null;
		if (Object.getOwnPropertySymbols(value).length > 0) return null;
		const output = Object.create(null) as Record<string, unknown>;
		for (const [key, descriptor] of Object.entries(
			Object.getOwnPropertyDescriptors(value),
		)) {
			if (!descriptor.enumerable || !('value' in descriptor)) return null;
			output[key] = descriptor.value;
		}
		return output;
	} catch {
		return null;
	}
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	allowedKeys: readonly string[],
): boolean {
	const allowed = new Set(allowedKeys);
	return Object.keys(value).every((key) => allowed.has(key));
}

function boundedTrimmedText(
	value: unknown,
	maxBytes: number,
): string | undefined {
	if (typeof value !== 'string') return undefined;
	const normalized = value.trim();
	if (!normalized || utf8ByteLength(normalized) > maxBytes) return undefined;
	return normalized;
}

function boundedText(value: unknown, maxBytes: number): string | undefined {
	if (typeof value !== 'string' || utf8ByteLength(value) > maxBytes) {
		return undefined;
	}
	return value;
}

function emptyPayload(
	value: Record<string, unknown>,
): Record<string, unknown> | null {
	return Object.keys(value).length === 0 ? {} : null;
}

function identifierPayload(
	value: Record<string, unknown>,
): Record<string, unknown> | null {
	if (!hasOnlyKeys(value, ['id'])) return null;
	const id = boundedTrimmedText(value.id, MAX_IDENTIFIER_BYTES);
	return id ? { id } : null;
}

function actionPayload(
	tool: DesktopToolId,
	command: string,
	payload: Record<string, unknown>,
): Record<string, unknown> | null {
	const action = `${tool}.${command}`;
	if (action === 'network.clear' || action === 'console.clear') {
		return emptyPayload(payload);
	}
	if (action === 'storage.set') {
		if (!hasOnlyKeys(payload, ['id', 'valueText'])) return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const valueText = boundedText(payload.valueText, MAX_LONG_TEXT_BYTES);
		return id && valueText !== undefined ? { id, valueText } : null;
	}
	if (action === 'query.refetch' || action === 'query.invalidate') {
		return identifierPayload(payload);
	}
	if (action === 'routes.navigate') {
		if (!hasOnlyKeys(payload, ['path'])) return null;
		const path = boundedTrimmedText(payload.path, MAX_SHORT_TEXT_BYTES);
		return path ? { path } : null;
	}
	if (action === 'zustand.refresh' || action === 'components.refresh') {
		return emptyPayload(payload);
	}
	if (action === 'components.highlight') return identifierPayload(payload);
	if (action === 'restore.capture') {
		if (!hasOnlyKeys(payload, ['label'])) return null;
		if (payload.label === undefined) return {};
		const label = boundedTrimmedText(payload.label, MAX_SHORT_TEXT_BYTES);
		return label ? { label } : null;
	}
	if (action === 'restore.restore' || action === 'restore.remove') {
		return identifierPayload(payload);
	}
	if (action === 'performance.start' || action === 'performance.stop') {
		return emptyPayload(payload);
	}
	return null;
}

export function isDesktopToolId(value: unknown): value is DesktopToolId {
	return typeof value === 'string' && toolIds.has(value);
}

export function desktopActionCapability(
	tool: DesktopToolId,
	command: string,
): DesktopActionCapability | undefined {
	const action = `${tool}.${command}`;
	const capability =
		action === 'storage.set'
			? 'storage.write'
			: action === 'performance.start' || action === 'performance.stop'
				? 'performance.review'
				: action;
	return actionCapabilities.has(capability)
		? (capability as DesktopActionCapability)
		: undefined;
}

/** Parse and normalize the untrusted body of a desktop action envelope. */
export function parseDesktopDeviceAction(
	value: unknown,
): DesktopDeviceAction | null {
	try {
		const record = dataRecord(value);
		if (!record) return null;
		if (
			!hasOnlyKeys(record, [
				'actionId',
				'deviceId',
				'tool',
				'command',
				'payload',
			])
		) {
			return null;
		}
		const actionId = boundedTrimmedText(record.actionId, MAX_IDENTIFIER_BYTES);
		const deviceId = boundedTrimmedText(record.deviceId, MAX_IDENTIFIER_BYTES);
		const command = boundedTrimmedText(record.command, MAX_COMMAND_BYTES);
		const payloadRecord = dataRecord(record.payload);
		if (
			!actionId ||
			!deviceId ||
			!isDesktopToolId(record.tool) ||
			!command ||
			!payloadRecord ||
			!desktopActionCapability(record.tool, command)
		) {
			return null;
		}
		const payload = actionPayload(record.tool, command, payloadRecord);
		if (!payload) return null;
		return { actionId, deviceId, tool: record.tool, command, payload };
	} catch {
		// Untrusted proxies and coercion hooks are invalid protocol values.
		return null;
	}
}

export function parseDesktopActionEnvelope(
	value: unknown,
): DesktopDeviceAction | null {
	try {
		const record = dataRecord(value);
		if (
			!record ||
			!hasOnlyKeys(record, ['type', 'action']) ||
			record.type !== 'action'
		) {
			return null;
		}
		return parseDesktopDeviceAction(record.action);
	} catch {
		return null;
	}
}
