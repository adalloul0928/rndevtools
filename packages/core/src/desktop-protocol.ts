import { utf8ByteLength } from './core/serialize';
import {
	isNetworkSimulationProfileId,
	type NetworkSimulationProfileId,
} from './network-profile';

export const RNDEVTOOLS_PROTOCOL_VERSION = 2 as const;
export const RNDEVTOOLS_SUPPORTED_PROTOCOL_VERSIONS = [1, 2] as const;

export type DesktopProtocolVersion =
	(typeof RNDEVTOOLS_SUPPORTED_PROTOCOL_VERSIONS)[number];

export const RNDEVTOOLS_TOOL_IDS = [
	'network',
	'console',
	'storage',
	'query',
	'routes',
	'environment',
	'zustand',
	'restore',
	'scenarios',
	'identity',
	'performance',
	'components',
	'camera',
	'diagnostics',
] as const;

export type DesktopToolId = (typeof RNDEVTOOLS_TOOL_IDS)[number];

/** Shared collection limits keep mobile projections within the desktop schema. */
export const RNDEVTOOLS_SNAPSHOT_LIMITS = {
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
	zustandStateSnapshots: 100,
	zustandMutationReceipts: 1_000,
	restorePoints: 100,
	restoreSources: 50,
	restoreReceipts: 100,
	scenarios: 100,
	scenarioVariables: 25,
	scenarioSteps: 100,
	scenarioReceipts: 100,
	identityHistory: 20,
	identityPersonas: 50,
	components: 2_000,
	componentRenders: 2_000,
	componentSourceFiles: 20,
	componentDiagnostics: 500,
	performanceSamples: 1_500,
	diagnostics: 2_000,
} as const;

export type DesktopSnapshotLimit = keyof typeof RNDEVTOOLS_SNAPSHOT_LIMITS;

/**
 * Item caps the desktop schema applies beyond `RNDEVTOOLS_SNAPSHOT_LIMITS`:
 * fields of a map and entries of a list inside a row.
 */
export const RNDEVTOOLS_SNAPSHOT_EXTRA_LIMITS = {
	headerFields: 200,
	storageStructuralDiff: 200,
	storageSummaryErrors: 10,
	querySimulationFamilies: 50,
	querySimulationModes: 4,
	scenarioVariableOptions: 50,
	scenarioWarnings: 100,
	componentActions: 4,
	componentRenderChangedKeys: 20,
	accessibilityStateFields: 50,
} as const;

/**
 * Longest text the desktop schema takes, before it redacts. The schema counts
 * code points; `fitDesktopSnapshot` cuts by UTF-16 code units, which is never
 * longer. `identifier` and `httpMethod` are measured after trimming.
 */
export const RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS = {
	identifier: 256,
	httpMethod: 16,
	headerName: 256,
	short: 4 * 1024,
	long: 512 * 1024,
	scenario: 16 * 1024,
} as const;

/**
 * Largest values the desktop schema takes, beyond the finite, non-negative and
 * safe-integer checks it applies to its numbers everywhere.
 */
export const RNDEVTOOLS_SNAPSHOT_NUMBER_LIMITS = {
	timestamp: 8_640_000_000_000_000,
	httpStatus: 999,
	fps: 240,
	cpuPercent: 100,
	zustandStateBytes: 1024 * 1024,
	componentDepth: 100,
	componentZIndex: 100_000,
	renderDurationMs: 60_000,
	renderCount: 1_000_000_000,
	cameraFixtureBytes: 384 * 1024,
	cameraFixtureDimension: 16_384,
	cameraFixtureDurationMs: 10 * 60 * 1_000,
} as const;

/**
 * Every remotely invokable operation has one capability with the same
 * `tool.command` spelling. Read-only tools intentionally have no capability.
 */
export const RNDEVTOOLS_ACTION_CAPABILITIES = [
	'network.clear',
	'network.setProfile',
	'network.clearProfile',
	'console.clear',
	'storage.write',
	'storage.undo',
	'storage.bookmark',
	'query.refetch',
	'query.invalidate',
	'query.simulate',
	'query.clearSimulation',
	'routes.navigate',
	'zustand.refresh',
	'zustand.capture',
	'zustand.patch',
	'zustand.jump',
	'restore.capture',
	'restore.restore',
	'restore.resetBaseline',
	'restore.rename',
	'restore.duplicate',
	'restore.remove',
	'scenarios.execute',
	'scenarios.undo',
	'scenarios.discardRecovery',
	'scenarios.import',
	'scenarios.remove',
	'identity.start',
	'identity.stop',
	'performance.review',
	'components.refresh',
	'components.highlight',
	'components.activate',
	'components.focus',
	'components.setText',
	'components.scroll',
	'components.waitForElement',
	'components.waitForScreenChange',
	'camera.setFixture',
	'camera.clearFixture',
] as const;

export type DesktopActionCapability =
	(typeof RNDEVTOOLS_ACTION_CAPABILITIES)[number];

/** Local state changes: in-memory work or one on-device write. */
const QUICK_ACTION_TIMEOUT_MS = 10_000;
/**
 * Work that waits on the network, on the app settling (a component wait
 * carries a payload timeout of up to 10 s), on a restore across up to 50
 * sources, or on a person answering an on-device confirmation.
 */
const INTERACTIVE_ACTION_TIMEOUT_MS = 30_000;
/**
 * Scenario runs and undos. The engine bounds each precondition, preflight,
 * rollback capture, apply and rollback at 30 s by default, and a scenario may
 * have many steps, so these get the longest allowance.
 */
const SCENARIO_ACTION_TIMEOUT_MS = 5 * 60_000;

/**
 * How long the desktop keeps waiting after the device's own deadline for the
 * result to arrive. Results go out before snapshots, so one waits at most for
 * the oldest frame to leave the client's 1.5 s pacing window, plus transit and
 * timer slack.
 */
export const RNDEVTOOLS_ACTION_ACKNOWLEDGEMENT_GRACE_MS = 5_000;

/**
 * How long the device may spend on each remotely invokable operation. The
 * client gives up on a host action after this long, and the desktop waits this
 * long plus `RNDEVTOOLS_ACTION_ACKNOWLEDGEMENT_GRACE_MS` for the result, so the
 * desktop never reports an action unacknowledged while the device is still
 * entitled to be running it. A capability without an entry here does not
 * compile.
 */
export const RNDEVTOOLS_ACTION_TIMEOUTS_MS = {
	'network.clear': QUICK_ACTION_TIMEOUT_MS,
	'network.setProfile': QUICK_ACTION_TIMEOUT_MS,
	'network.clearProfile': QUICK_ACTION_TIMEOUT_MS,
	'console.clear': QUICK_ACTION_TIMEOUT_MS,
	'storage.write': QUICK_ACTION_TIMEOUT_MS,
	'storage.undo': QUICK_ACTION_TIMEOUT_MS,
	'storage.bookmark': QUICK_ACTION_TIMEOUT_MS,
	'query.refetch': INTERACTIVE_ACTION_TIMEOUT_MS,
	'query.invalidate': INTERACTIVE_ACTION_TIMEOUT_MS,
	'query.simulate': QUICK_ACTION_TIMEOUT_MS,
	'query.clearSimulation': QUICK_ACTION_TIMEOUT_MS,
	'routes.navigate': QUICK_ACTION_TIMEOUT_MS,
	'zustand.refresh': QUICK_ACTION_TIMEOUT_MS,
	'zustand.capture': QUICK_ACTION_TIMEOUT_MS,
	'zustand.patch': QUICK_ACTION_TIMEOUT_MS,
	'zustand.jump': QUICK_ACTION_TIMEOUT_MS,
	'restore.capture': INTERACTIVE_ACTION_TIMEOUT_MS,
	'restore.restore': INTERACTIVE_ACTION_TIMEOUT_MS,
	'restore.resetBaseline': INTERACTIVE_ACTION_TIMEOUT_MS,
	'restore.rename': INTERACTIVE_ACTION_TIMEOUT_MS,
	'restore.duplicate': INTERACTIVE_ACTION_TIMEOUT_MS,
	'restore.remove': INTERACTIVE_ACTION_TIMEOUT_MS,
	'scenarios.execute': SCENARIO_ACTION_TIMEOUT_MS,
	'scenarios.undo': SCENARIO_ACTION_TIMEOUT_MS,
	'scenarios.discardRecovery': INTERACTIVE_ACTION_TIMEOUT_MS,
	'scenarios.import': QUICK_ACTION_TIMEOUT_MS,
	'scenarios.remove': QUICK_ACTION_TIMEOUT_MS,
	'identity.start': INTERACTIVE_ACTION_TIMEOUT_MS,
	'identity.stop': INTERACTIVE_ACTION_TIMEOUT_MS,
	'performance.review': QUICK_ACTION_TIMEOUT_MS,
	'components.refresh': QUICK_ACTION_TIMEOUT_MS,
	'components.highlight': QUICK_ACTION_TIMEOUT_MS,
	'components.activate': QUICK_ACTION_TIMEOUT_MS,
	'components.focus': QUICK_ACTION_TIMEOUT_MS,
	'components.setText': QUICK_ACTION_TIMEOUT_MS,
	'components.scroll': QUICK_ACTION_TIMEOUT_MS,
	'components.waitForElement': INTERACTIVE_ACTION_TIMEOUT_MS,
	'components.waitForScreenChange': INTERACTIVE_ACTION_TIMEOUT_MS,
	'camera.setFixture': QUICK_ACTION_TIMEOUT_MS,
	'camera.clearFixture': QUICK_ACTION_TIMEOUT_MS,
} as const satisfies Readonly<Record<DesktopActionCapability, number>>;

/**
 * How long the device may spend on `tool.command`. A command without a
 * capability is refused by both sides before either starts a timer, so the
 * quick bound is only a defensive fallback.
 */
export function desktopActionTimeoutMs(
	tool: DesktopToolId,
	command: string,
): number {
	const capability = desktopActionCapability(tool, command);
	return capability
		? RNDEVTOOLS_ACTION_TIMEOUTS_MS[capability]
		: QUICK_ACTION_TIMEOUT_MS;
}

/** How long the desktop waits for the result of `tool.command`. */
export function desktopActionAcknowledgementTimeoutMs(
	tool: DesktopToolId,
	command: string,
): number {
	return (
		desktopActionTimeoutMs(tool, command) +
		RNDEVTOOLS_ACTION_ACKNOWLEDGEMENT_GRACE_MS
	);
}

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
	simulatorUdid?: string | undefined;
	bundleIdentifier?: string | undefined;
	processId?: number | undefined;
	viewport?: { width: number; height: number } | undefined;
	capabilities: readonly DesktopActionCapability[];
};

/**
 * Supplies every required collection. Override the tools the host collects:
 * `{ ...createEmptyDesktopToolsSnapshot(), network: myNetworkProjection }`.
 */
export function createEmptyDesktopToolsSnapshot(): DesktopDeviceToolsSnapshot {
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
		zustandStateSnapshots: [],
		zustandMutationReceipts: [],
		zustandSummary: {
			totalStoreCount: 0,
			omittedStoreCount: 0,
			truncated: false,
		},
		restorePoints: [],
		restoreReceipts: [],
		scenarios: [],
		scenarioRuntime: { running: false },
		scenarioReceipts: [],
		identitySession: { running: false, history: [], personas: [] },
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
		componentRenders: [],
		componentSummary: {
			sourceTargetCount: 0,
			omittedTargetCount: 0,
			truncated: false,
		},
		diagnostics: [],
	};
}

export type DesktopCameraFixtureKind =
	| 'still'
	| 'qr'
	| 'video'
	| 'unavailable'
	| 'error';

export type DesktopCameraFixtureSnapshot = {
	active: boolean;
	kind?: DesktopCameraFixtureKind | undefined;
	label?: string | undefined;
	mimeType?: string | undefined;
	bytes?: number | undefined;
	width?: number | undefined;
	height?: number | undefined;
	durationMs?: number | undefined;
};

type DesktopIdentitySnapshot = {
	kind: 'signed-out' | 'account' | 'persona';
	label: string;
	personaId?: string | undefined;
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
	firstAt?: number | undefined;
	lastAt?: number | undefined;
	level: 'debug' | 'info' | 'warn' | 'error';
	message: string;
	attributesText?: string | undefined;
	source?: string | undefined;
	scope?: string | undefined;
	correlationId?: string | undefined;
	groupId?: string | undefined;
	repeatCount?: number | undefined;
	errorName?: string | undefined;
	errorStack?: string | undefined;
	sourceLocation?:
		| {
				file: string;
				line?: number | undefined;
				column?: number | undefined;
		  }
		| undefined;
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
	bookmarked?: boolean | undefined;
	undoAvailable?: boolean | undefined;
	undoStatus?: 'available' | 'expired' | 'succeeded' | 'failed' | undefined;
	structuralDiff?:
		| readonly {
				path: string;
				kind: 'added' | 'changed' | 'removed';
				previousText?: string | undefined;
				nextText?: string | undefined;
		  }[]
		| undefined;
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

type DesktopQuerySimulationSnapshot = {
	families: readonly {
		id: string;
		label: string;
		description?: string | undefined;
		modes: readonly {
			mode: 'loading' | 'error' | 'paused' | 'offline';
			supported: boolean;
			reason?: string | undefined;
		}[];
	}[];
	active?:
		| {
				familyId: string;
				familyLabel: string;
				mode: 'loading' | 'error' | 'paused' | 'offline';
				receiptId: string;
				startedAt: number;
		  }
		| undefined;
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
	networkProfile?:
		| {
				id: NetworkSimulationProfileId;
				name: string;
				active: boolean;
				scope: 'instrumented-fetch';
		  }
		| undefined;
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
	querySimulation?: DesktopQuerySimulationSnapshot | undefined;
	routes: readonly DesktopRouteSnapshot[];
	routeEvents: readonly {
		id: string;
		at: number;
		route: string;
		metadataText?: string | undefined;
		transitionId?: string | undefined;
		phase?: 'requested' | 'committed' | 'focused' | 'failed' | undefined;
		source?:
			| 'app'
			| 'panel'
			| 'desktop'
			| 'scenario'
			| 'restore'
			| 'deep-link'
			| undefined;
		correlationId?: string | undefined;
		durationMs?: number | undefined;
		error?: string | undefined;
	}[];
	environment: readonly DesktopEnvironmentSnapshot[];
	zustandStores: readonly {
		id: string;
		title: string;
		description?: string | undefined;
		stateText: string;
		keys: readonly string[];
		updatedAt: number;
		capabilities: {
			writable: boolean;
			resettable: boolean;
			persisted: boolean;
			restorable: boolean;
		};
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
	zustandStateSnapshots: readonly {
		id: string;
		storeId: string;
		storeTitle: string;
		createdAt: number;
		stateText: string;
		stateBytes: number;
		truncated: boolean;
	}[];
	zustandMutationReceipts: readonly {
		id: string;
		storeId: string;
		kind: 'patch' | 'reset' | 'jump';
		status: 'succeeded' | 'failed' | 'rolled-back' | 'needs-attention';
		startedAt: number;
		completedAt: number;
		changedKeys: readonly string[];
		correlationId?: string | undefined;
		snapshotId?: string | undefined;
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
	restoreReceipts: readonly {
		id: string;
		pointId: string;
		pointLabel: string;
		startedAt: number;
		completedAt: number;
		status: 'complete' | 'preflight-failed' | 'rolled-back' | 'needs-attention';
		error?: string | undefined;
		sourceResults: readonly {
			sourceId: string;
			sourceTitle: string;
			preflight: 'pending' | 'passed' | 'failed';
			apply: 'not-run' | 'succeeded' | 'failed';
			rollback: 'not-needed' | 'succeeded' | 'failed';
			error?: string | undefined;
			rollbackError?: string | undefined;
		}[];
	}[];
	scenarios: readonly {
		id: string;
		version: number;
		definitionToken: string;
		name: string;
		description?: string | undefined;
		bundled: boolean;
		variables: readonly {
			id: string;
			label: string;
			type: 'string' | 'number' | 'boolean';
			required: boolean;
			defaultValue?: string | number | boolean | null | undefined;
			options?: readonly (string | number | boolean | null)[] | undefined;
		}[];
		preconditionCount: number;
		steps: readonly {
			id: string;
			type:
				| 'network-profile'
				| 'storage-write'
				| 'zustand-write'
				| 'query-simulation'
				| 'developer-overrides'
				| 'impersonation'
				| 'navigation'
				| 'custom-action';
			label?: string | undefined;
		}[];
	}[];
	scenarioRuntime: {
		running: boolean;
		recoveryError?: string | undefined;
		active?:
			| {
					receiptId: string;
					scenarioId: string;
					scenarioVersion: number;
					scenarioName: string;
					activatedAt: number;
					stepCount: number;
					privileged: boolean;
					warnings: readonly string[];
					recoveryRequired: boolean;
			  }
			| undefined;
	};
	scenarioReceipts: readonly {
		id: string;
		scenarioId: string;
		scenarioVersion: number;
		scenarioName: string;
		startedAt: number;
		completedAt: number;
		status: 'complete' | 'preflight-failed' | 'rolled-back' | 'needs-attention';
		error?: string | undefined;
		stepResults: readonly {
			stepId: string;
			stepType:
				| 'network-profile'
				| 'storage-write'
				| 'zustand-write'
				| 'query-simulation'
				| 'developer-overrides'
				| 'impersonation'
				| 'navigation'
				| 'custom-action';
			label: string;
			preflight: 'pending' | 'passed' | 'failed';
			apply: 'not-run' | 'succeeded' | 'failed';
			rollback: 'not-needed' | 'succeeded' | 'failed';
			reversible?: boolean | undefined;
			privileged?: boolean | undefined;
			warnings?: readonly string[] | undefined;
			summary?: string | undefined;
			error?: string | undefined;
			rollbackError?: string | undefined;
		}[];
	}[];
	identitySession: {
		running: boolean;
		active?:
			| {
					historyId: string;
					startedAt: number;
					actor: DesktopIdentitySnapshot;
					target: DesktopIdentitySnapshot;
					status: 'active' | 'needs-attention';
					error?: string | undefined;
			  }
			| undefined;
		history: readonly {
			id: string;
			startedAt: number;
			stoppedAt?: number | undefined;
			actor: DesktopIdentitySnapshot;
			target: DesktopIdentitySnapshot;
			status: 'active' | 'stopped' | 'needs-attention';
			error?: string | undefined;
		}[];
		personas: readonly {
			id: string;
			label: string;
			note: string;
		}[];
	};
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
		targetId?: string | undefined;
		parentId?: string | undefined;
		depth?: number | undefined;
		zIndex?: number | undefined;
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
		accessibilityLabel?: string | undefined;
		accessibilityHint?: string | undefined;
		accessibilityRole?: string | undefined;
		accessibilityValue?: string | undefined;
		accessibilityState?: Readonly<Record<string, boolean | string>> | undefined;
		styleText?: string | undefined;
		styleTruncated?: boolean | undefined;
		/** Protocol v2 semantic actions; absent on protocol v1 snapshots. */
		actions?:
			| readonly ('activate' | 'focus' | 'setText' | 'scroll')[]
			| undefined;
		/** Protocol v2 screen identity; absent on protocol v1 snapshots. */
		screenHash?: string | undefined;
	}[];
	componentRenders: readonly {
		id: string;
		targetId: string;
		at: number;
		phase: 'mount' | 'update' | 'nested-update';
		actualDuration: number;
		baseDuration: number;
		startTime: number;
		commitTime: number;
		renderCount: number;
		cause: 'mount' | 'props' | 'tracked-state' | 'parent' | 'unknown';
		changedKeys: readonly string[];
	}[];
	componentSummary: {
		sourceTargetCount: number;
		omittedTargetCount: number;
		truncated: boolean;
		/** Protocol v2 screen identity; absent on protocol v1 snapshots. */
		screenHash?: string | undefined;
		registrationDiagnostics?:
			| readonly {
					code: 'duplicate-target-id' | 'orphan-parent' | 'invalid-hierarchy';
					targetId: string;
					instanceIds: readonly string[];
					message: string;
			  }[]
			| undefined;
		error?: string | undefined;
	};
	/** Protocol v2 camera fixture status; absent on protocol v1 snapshots. */
	cameraFixture?: DesktopCameraFixtureSnapshot | undefined;
	diagnostics: readonly DesktopDiagnosticSnapshot[];
};

const toolIds = new Set<string>(RNDEVTOOLS_TOOL_IDS);
const actionCapabilities = new Set<string>(RNDEVTOOLS_ACTION_CAPABILITIES);

const MAX_IDENTIFIER_BYTES = 256;
const MAX_COMMAND_BYTES = 128;
const MAX_SHORT_TEXT_BYTES = 4 * 1024;
const MAX_LONG_TEXT_BYTES = 512 * 1024;
// Camera fixture actions share the bounded desktop action channel, whose full
// JSON envelope is capped at 600 KiB by the mobile client. Keep the encoded
// payload below that boundary so metadata and JSON overhead cannot turn an
// otherwise valid fixture into an oversized action.
const MAX_CAMERA_FIXTURE_BASE64_BYTES = 512 * 1024;

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

function identifierList(
	value: unknown,
	maximum: number,
): readonly string[] | null {
	if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
		return null;
	}
	const identifiers: string[] = [];
	const seen = new Set<string>();
	for (const candidate of value) {
		const identifier = boundedTrimmedText(candidate, MAX_IDENTIFIER_BYTES);
		if (!identifier || seen.has(identifier)) return null;
		seen.add(identifier);
		identifiers.push(identifier);
	}
	return identifiers;
}

function scenarioVariables(
	value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | null {
	const record = dataRecord(value);
	if (!record || Object.keys(record).length > 25) return null;
	const output = Object.create(null) as Record<
		string,
		string | number | boolean | null
	>;
	for (const [key, candidate] of Object.entries(record)) {
		const id = boundedTrimmedText(key, MAX_IDENTIFIER_BYTES);
		if (!id || id !== key) return null;
		if (typeof candidate === 'string') {
			if (utf8ByteLength(candidate) > 16 * 1024) return null;
			output[id] = candidate;
			continue;
		}
		if (
			candidate === null ||
			typeof candidate === 'boolean' ||
			(typeof candidate === 'number' && Number.isFinite(candidate))
		) {
			output[id] = candidate;
			continue;
		}
		return null;
	}
	return output;
}

function componentTargetPayload(
	value: Record<string, unknown>,
): { id: string; screenHash: string } | null {
	const id = boundedTrimmedText(value.id, MAX_IDENTIFIER_BYTES);
	const screenHash = boundedTrimmedText(value.screenHash, MAX_IDENTIFIER_BYTES);
	return id && screenHash ? { id, screenHash } : null;
}

function boundedTimeout(value: unknown): number | undefined {
	return typeof value === 'number' &&
		Number.isInteger(value) &&
		value >= 50 &&
		value <= 10_000
		? value
		: undefined;
}

function boundedPositiveInteger(
	value: unknown,
	maximum: number,
): number | undefined {
	return typeof value === 'number' &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= maximum
		? value
		: undefined;
}

function cameraFixturePayload(
	payload: Record<string, unknown>,
): Record<string, unknown> | null {
	if (
		!hasOnlyKeys(payload, [
			'kind',
			'label',
			'mimeType',
			'dataBase64',
			'width',
			'height',
			'durationMs',
			'errorMessage',
		])
	) {
		return null;
	}
	const kind = payload.kind;
	if (
		kind !== 'still' &&
		kind !== 'qr' &&
		kind !== 'video' &&
		kind !== 'unavailable' &&
		kind !== 'error'
	) {
		return null;
	}
	const label =
		payload.label === undefined
			? undefined
			: boundedTrimmedText(payload.label, MAX_SHORT_TEXT_BYTES);
	if (payload.label !== undefined && !label) return null;
	if (kind === 'unavailable') {
		return Object.keys(payload).every(
			(key) => key === 'kind' || key === 'label',
		)
			? { kind, ...(label ? { label } : {}) }
			: null;
	}
	if (kind === 'error') {
		if (
			!Object.keys(payload).every((key) =>
				['kind', 'label', 'errorMessage'].includes(key),
			)
		) {
			return null;
		}
		const errorMessage = boundedTrimmedText(
			payload.errorMessage,
			MAX_SHORT_TEXT_BYTES,
		);
		return errorMessage
			? { kind, errorMessage, ...(label ? { label } : {}) }
			: null;
	}

	const mimeType = boundedTrimmedText(payload.mimeType, 128)?.toLowerCase();
	const dataBase64 = boundedText(
		payload.dataBase64,
		MAX_CAMERA_FIXTURE_BASE64_BYTES,
	);
	const width = boundedPositiveInteger(payload.width, 16_384);
	const height = boundedPositiveInteger(payload.height, 16_384);
	if (!mimeType || !dataBase64 || !width || !height) return null;
	if (
		dataBase64.length === 0 ||
		dataBase64.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)
	) {
		return null;
	}
	if (kind === 'still' || kind === 'qr') {
		if (
			mimeType !== 'image/jpeg' &&
			mimeType !== 'image/png' &&
			mimeType !== 'image/webp'
		) {
			return null;
		}
		if (
			payload.durationMs !== undefined ||
			payload.errorMessage !== undefined
		) {
			return null;
		}
		return {
			kind,
			mimeType,
			dataBase64,
			width,
			height,
			...(label ? { label } : {}),
		};
	}
	if (mimeType !== 'video/mp4' && mimeType !== 'video/quicktime') return null;
	if (payload.errorMessage !== undefined) return null;
	const durationMs = boundedPositiveInteger(
		payload.durationMs,
		10 * 60 * 1_000,
	);
	if (!durationMs) return null;
	return {
		kind,
		mimeType,
		dataBase64,
		width,
		height,
		durationMs,
		...(label ? { label } : {}),
	};
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
	if (action === 'network.clearProfile') return emptyPayload(payload);
	if (action === 'network.setProfile') {
		if (!hasOnlyKeys(payload, ['profileId'])) return null;
		return isNetworkSimulationProfileId(payload.profileId) &&
			payload.profileId !== 'none'
			? { profileId: payload.profileId }
			: null;
	}
	if (action === 'storage.set') {
		if (!hasOnlyKeys(payload, ['id', 'valueText'])) return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const valueText = boundedText(payload.valueText, MAX_LONG_TEXT_BYTES);
		return id && valueText !== undefined ? { id, valueText } : null;
	}
	if (action === 'storage.undo' || action === 'storage.bookmark') {
		return identifierPayload(payload);
	}
	if (action === 'query.refetch' || action === 'query.invalidate') {
		return identifierPayload(payload);
	}
	if (action === 'query.simulate') {
		if (!hasOnlyKeys(payload, ['familyId', 'mode'])) return null;
		const familyId = boundedTrimmedText(payload.familyId, MAX_IDENTIFIER_BYTES);
		const mode = payload.mode;
		return familyId &&
			(mode === 'loading' ||
				mode === 'error' ||
				mode === 'paused' ||
				mode === 'offline')
			? { familyId, mode }
			: null;
	}
	if (action === 'query.clearSimulation') {
		if (!hasOnlyKeys(payload, ['receiptId'])) return null;
		const receiptId = boundedTrimmedText(
			payload.receiptId,
			MAX_IDENTIFIER_BYTES,
		);
		return receiptId ? { receiptId } : null;
	}
	if (action === 'routes.navigate') {
		if (!hasOnlyKeys(payload, ['path'])) return null;
		const path = boundedTrimmedText(payload.path, MAX_SHORT_TEXT_BYTES);
		return path ? { path } : null;
	}
	if (action === 'zustand.refresh' || action === 'components.refresh') {
		return emptyPayload(payload);
	}
	if (action === 'zustand.capture') {
		if (!hasOnlyKeys(payload, ['storeId'])) return null;
		const storeId = boundedTrimmedText(payload.storeId, MAX_IDENTIFIER_BYTES);
		return storeId ? { storeId } : null;
	}
	if (action === 'zustand.patch') {
		if (!hasOnlyKeys(payload, ['storeId', 'patchText'])) return null;
		const storeId = boundedTrimmedText(payload.storeId, MAX_IDENTIFIER_BYTES);
		const patchText = boundedText(payload.patchText, MAX_LONG_TEXT_BYTES);
		return storeId && patchText ? { storeId, patchText } : null;
	}
	if (action === 'zustand.jump') {
		if (!hasOnlyKeys(payload, ['storeId', 'snapshotId'])) return null;
		const storeId = boundedTrimmedText(payload.storeId, MAX_IDENTIFIER_BYTES);
		const snapshotId = boundedTrimmedText(
			payload.snapshotId,
			MAX_IDENTIFIER_BYTES,
		);
		return storeId && snapshotId ? { storeId, snapshotId } : null;
	}
	if (action === 'components.highlight') return identifierPayload(payload);
	if (action === 'components.activate' || action === 'components.focus') {
		if (!hasOnlyKeys(payload, ['id', 'screenHash'])) return null;
		return componentTargetPayload(payload);
	}
	if (action === 'components.setText') {
		if (!hasOnlyKeys(payload, ['id', 'screenHash', 'text'])) return null;
		const target = componentTargetPayload(payload);
		const text = boundedText(payload.text, 64 * 1024);
		return target && text !== undefined ? { ...target, text } : null;
	}
	if (action === 'components.scroll') {
		if (!hasOnlyKeys(payload, ['id', 'screenHash', 'direction', 'amount'])) {
			return null;
		}
		const target = componentTargetPayload(payload);
		const direction = payload.direction;
		if (
			!target ||
			(direction !== 'up' &&
				direction !== 'down' &&
				direction !== 'left' &&
				direction !== 'right')
		) {
			return null;
		}
		if (payload.amount === undefined) return { ...target, direction };
		return typeof payload.amount === 'number' &&
			Number.isFinite(payload.amount) &&
			payload.amount > 0 &&
			payload.amount <= 1
			? { ...target, direction, amount: payload.amount }
			: null;
	}
	if (action === 'components.waitForElement') {
		if (!hasOnlyKeys(payload, ['id', 'timeoutMs'])) return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const timeoutMs = boundedTimeout(payload.timeoutMs);
		return id && timeoutMs ? { id, timeoutMs } : null;
	}
	if (action === 'components.waitForScreenChange') {
		if (!hasOnlyKeys(payload, ['screenHash', 'timeoutMs'])) return null;
		const screenHash = boundedTrimmedText(
			payload.screenHash,
			MAX_IDENTIFIER_BYTES,
		);
		const timeoutMs = boundedTimeout(payload.timeoutMs);
		return screenHash && timeoutMs ? { screenHash, timeoutMs } : null;
	}
	if (action === 'camera.clearFixture') return emptyPayload(payload);
	if (action === 'camera.setFixture') return cameraFixturePayload(payload);
	if (action === 'restore.capture') {
		if (!hasOnlyKeys(payload, ['label'])) return null;
		if (payload.label === undefined) return {};
		const label = boundedTrimmedText(payload.label, MAX_SHORT_TEXT_BYTES);
		return label ? { label } : null;
	}
	if (action === 'restore.resetBaseline') return emptyPayload(payload);
	if (action === 'restore.restore') {
		if (!hasOnlyKeys(payload, ['id', 'sourceIds'])) return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		if (!id) return null;
		if (payload.sourceIds === undefined) return { id };
		const sourceIds = identifierList(
			payload.sourceIds,
			RNDEVTOOLS_SNAPSHOT_LIMITS.restoreSources,
		);
		return sourceIds ? { id, sourceIds } : null;
	}
	if (action === 'restore.remove') return identifierPayload(payload);
	if (action === 'restore.rename' || action === 'restore.duplicate') {
		if (!hasOnlyKeys(payload, ['id', 'label'])) return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const label = boundedTrimmedText(payload.label, MAX_SHORT_TEXT_BYTES);
		return id && label ? { id, label } : null;
	}
	if (action === 'scenarios.execute') {
		if (
			!hasOnlyKeys(payload, ['id', 'version', 'definitionToken', 'variables'])
		)
			return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const version = boundedPositiveInteger(
			payload.version,
			Number.MAX_SAFE_INTEGER,
		);
		const definitionToken = boundedTrimmedText(
			payload.definitionToken,
			MAX_IDENTIFIER_BYTES,
		);
		if (!id || !version || !definitionToken) return null;
		if (payload.variables === undefined)
			return { id, version, definitionToken };
		const variables = scenarioVariables(payload.variables);
		return variables ? { id, version, definitionToken, variables } : null;
	}
	if (action === 'scenarios.undo') {
		if (!hasOnlyKeys(payload, ['receiptId'])) return null;
		const receiptId = boundedTrimmedText(
			payload.receiptId,
			MAX_IDENTIFIER_BYTES,
		);
		return receiptId ? { receiptId } : null;
	}
	if (action === 'scenarios.discardRecovery') {
		if (!hasOnlyKeys(payload, ['recoveryError'])) return null;
		const recoveryError = boundedTrimmedText(
			payload.recoveryError,
			MAX_LONG_TEXT_BYTES,
		);
		return recoveryError ? { recoveryError } : null;
	}
	if (action === 'scenarios.import') {
		if (!hasOnlyKeys(payload, ['json', 'mode'])) return null;
		const json = boundedText(payload.json, MAX_LONG_TEXT_BYTES);
		const mode = payload.mode;
		return json !== undefined && (mode === 'replace' || mode === 'merge')
			? { json, mode }
			: null;
	}
	if (action === 'scenarios.remove') {
		if (!hasOnlyKeys(payload, ['id', 'version', 'definitionToken']))
			return null;
		const id = boundedTrimmedText(payload.id, MAX_IDENTIFIER_BYTES);
		const version = boundedPositiveInteger(
			payload.version,
			Number.MAX_SAFE_INTEGER,
		);
		const definitionToken = boundedTrimmedText(
			payload.definitionToken,
			MAX_IDENTIFIER_BYTES,
		);
		return id && version && definitionToken
			? { id, version, definitionToken }
			: null;
	}
	if (action === 'identity.start') {
		if (!hasOnlyKeys(payload, ['personaId'])) return null;
		const personaId = boundedTrimmedText(
			payload.personaId,
			MAX_IDENTIFIER_BYTES,
		);
		return personaId ? { personaId } : null;
	}
	if (action === 'identity.stop') return emptyPayload(payload);
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
			: action === 'storage.undo'
				? 'storage.undo'
				: action === 'storage.bookmark'
					? 'storage.bookmark'
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

// Fitting a snapshot to the desktop schema

// The rules below mirror the desktop's snapshot schema field by field, and the
// tables above are where the two share their bounds. A rule is built once,
// from the path of its field, so fitting costs one call per bounded field and
// joins no path. `snapshot-fit.test.ts` in the desktop app holds the rules to
// the schema: it lists every bounded field, so a field added to the contract
// or a bound changed in only one of the two fails it.

const LIMITS = RNDEVTOOLS_SNAPSHOT_LIMITS;
const EXTRA = RNDEVTOOLS_SNAPSHOT_EXTRA_LIMITS;
const TEXT = RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS;
const NUMBERS = RNDEVTOOLS_SNAPSHOT_NUMBER_LIMITS;

/** What a fit changed, each change described once, in the order it was met. */
type FitTrace = Set<string>;

/** Returns `value` itself or a changed copy of it, and records the change. */
type Fit<T> = (value: T, trace: FitTrace) => T;

/**
 * Builds the `Fit` of the field at `label`, its path in the snapshot, which
 * also names the changes the `Fit` records. A rule is built once, when the
 * first snapshot is fitted, so no path is joined again for every row.
 */
type FitRule<T> = (label: string) => Fit<T>;

/** One rule for every key of `T`, so a field added to the contract needs one. */
type FitRules<T> = { readonly [K in keyof T]-?: FitRule<T[K]> };

/**
 * Which rows of a list over its cap survive: its first, its last, or the ones
 * a function picks.
 */
type Retained<T = never> =
	| 'first'
	| 'newest'
	| ((rows: readonly T[], limit: number) => readonly T[]);

/**
 * The `limit` rows with the greatest `read(row)`, kept in their own order, for
 * a list whose order the contract does not fix. A row without a finite number
 * ranks last, and between equal ranks the later row wins.
 */
function latestBy<T>(read: (row: T) => unknown) {
	return (rows: readonly T[], limit: number): readonly T[] => {
		const ranked = rows.map((row, index) => {
			const value = typeof row === 'object' && row !== null ? read(row) : null;
			return {
				index,
				at:
					typeof value === 'number' && Number.isFinite(value)
						? value
						: Number.NEGATIVE_INFINITY,
			};
		});
		ranked.sort((a, b) =>
			a.at === b.at ? b.index - a.index : a.at > b.at ? -1 : 1,
		);
		const kept = new Set(ranked.slice(0, limit).map(({ index }) => index));
		return rows.filter((_, index) => kept.has(index));
	};
}

/** For a field the schema does not bound, such as a flag or an enum. */
function keepAsIs<T>(_label: string): Fit<T> {
	return (value) => value;
}

/** Cuts `value` to `limit` code units without leaving half a surrogate pair. */
function cutText(value: string, limit: number): string {
	const last = value.charCodeAt(limit - 1);
	return value.slice(0, last >= 0xd800 && last <= 0xdbff ? limit - 1 : limit);
}

/**
 * A text cut to `limit`. Anything that is not a string is left for the
 * desktop schema to judge, so a malformed snapshot is rejected there rather
 * than thrown on here. A boolean is allowed in the type for a map of
 * accessibility state, which holds both.
 */
function fitText(limit: number) {
	return <T extends string | boolean | undefined>(label: string): Fit<T> => {
		const change = `${label} to ${limit} characters`;
		return (value, trace) => {
			if (typeof value !== 'string' || value.length <= limit) return value;
			trace.add(change);
			return cutText(value, limit) as T;
		};
	};
}

/** A text the schema trims before it measures, so only the trimmed part counts. */
function fitTrimmedText(limit: number) {
	return <T extends string | undefined>(label: string): Fit<T> => {
		const change = `${label} to ${limit} characters`;
		return (value, trace) => {
			if (typeof value !== 'string' || value.length <= limit) return value;
			const trimmed = value.trim();
			if (trimmed.length <= limit) return value;
			trace.add(change);
			return cutText(trimmed, limit) as T;
		};
	};
}

type NumberBounds = Readonly<{ min: number; max: number; integer: boolean }>;

function finiteRange(min: number, max: number): NumberBounds {
	return { min, max, integer: false };
}

function integerRange(min: number, max: number): NumberBounds {
	return { min, max, integer: true };
}

function describeRange({ min, max }: NumberBounds): string {
	if (!Number.isFinite(min)) {
		return Number.isFinite(max) ? `at most ${max}` : 'finite numbers';
	}
	return Number.isFinite(max) ? `${min}..${max}` : `at least ${min}`;
}

/**
 * A required number clamped into `bounds`, an integer's fraction cut off. A
 * number that is not finite becomes the lower bound, or 0 where there is none.
 */
function fitNumber(bounds: NumberBounds): FitRule<number> {
	return (label) => {
		const change = `${label} to ${describeRange(bounds)}`;
		const fallback = Number.isFinite(bounds.min) ? bounds.min : 0;
		return (value, trace) => {
			if (typeof value !== 'number') return value;
			let next = fallback;
			if (Number.isFinite(value)) {
				next = bounds.integer ? Math.trunc(value) : value;
				next = Math.min(Math.max(next, bounds.min), bounds.max);
			}
			if (next !== value) trace.add(change);
			return next;
		};
	};
}

/** As `fitNumber`, but an optional number that is not finite is dropped. */
function fitOptionalNumber(bounds: NumberBounds): FitRule<number | undefined> {
	return (label) => {
		const fit = fitNumber(bounds)(label);
		const change = `${label} dropped (not a finite number)`;
		return (value, trace) => {
			if (typeof value !== 'number') return value;
			if (Number.isFinite(value)) return fit(value, trace);
			trace.add(change);
			return undefined;
		};
	};
}

/** As `fitNumber`, but a number that is not finite becomes `null`, as JSON writes it. */
function fitNullableNumber(bounds: NumberBounds): FitRule<number | null> {
	return (label) => {
		const fit = fitNumber(bounds)(label);
		const change = `${label} to null (not a finite number)`;
		return (value, trace) => {
			if (typeof value !== 'number') return value;
			if (Number.isFinite(value)) return fit(value, trace);
			trace.add(change);
			return null;
		};
	};
}

function fitOptional<T>(rule: FitRule<T>): FitRule<T | undefined> {
	return (label) => {
		const fit = rule(label);
		return (value, trace) =>
			value === undefined ? undefined : fit(value, trace);
	};
}

function fitNullable<T>(rule: FitRule<T>): FitRule<T | null> {
	return (label) => {
		const fit = rule(label);
		return (value, trace) => (value === null ? null : fit(value, trace));
	};
}

/**
 * A list cut to `limit` rows, then each row fitted by `item`. The list and
 * its rows are copied only where something changed.
 */
function fitList<T>(
	limit: number,
	retained: Retained<T>,
	item: FitRule<T>,
): FitRule<readonly T[]> {
	return (label) => {
		const change = `${label} to ${limit} rows`;
		const fitRow = item === keepAsIs ? undefined : item(`${label}[]`);
		return (rows, trace) => {
			if (!Array.isArray(rows)) return rows;
			const source: readonly T[] = rows;
			let kept = source;
			if (source.length > limit) {
				trace.add(change);
				kept =
					retained === 'newest'
						? source.slice(-limit)
						: retained === 'first'
							? source.slice(0, limit)
							: retained(source, limit);
			}
			if (!fitRow) return kept;
			let fitted: T[] | undefined;
			for (let index = 0; index < kept.length; index += 1) {
				const row = kept[index] as T;
				const next = fitRow(row, trace);
				if (next === row) continue;
				fitted ??= kept === source ? source.slice() : (kept as T[]);
				fitted[index] = next;
			}
			return fitted ?? kept;
		};
	};
}

type FieldFit = Readonly<{ name: string; fit: Fit<unknown> }>;

/**
 * An object with each field fitted by its rule. `repair` runs on the fitted
 * object, for what only fields together can break.
 */
function fitObject<T extends object>(
	rules: FitRules<T>,
	repair?: (row: T, trace: FitTrace, label: string) => T,
): FitRule<T> {
	return (label) => {
		const fields: FieldFit[] = [];
		for (const [name, rule] of Object.entries(rules) as [
			string,
			FitRule<unknown>,
		][]) {
			if (rule === keepAsIs) continue;
			fields.push({ name, fit: rule(label ? `${label}.${name}` : name) });
		}
		return (row, trace) => {
			if (typeof row !== 'object' || row === null) return row;
			const current = row as Record<string, unknown>;
			let copy: Record<string, unknown> | undefined;
			for (let index = 0; index < fields.length; index += 1) {
				const { name, fit } = fields[index] as FieldFit;
				const value = current[name];
				const next = fit(value, trace);
				if (next === value) continue;
				copy ??= { ...current };
				if (next === undefined) delete copy[name];
				else copy[name] = next;
			}
			const fitted = (copy ?? row) as T;
			return repair ? repair(fitted, trace, label) : fitted;
		};
	};
}

/**
 * A map of at most `maxFields` fields. A field whose name is over
 * `maxNameLength` is dropped, not cut, since a cut name could collide with
 * another; the fields kept are the first.
 */
function fitRecord<V>(
	maxFields: number,
	maxNameLength: number,
	value: FitRule<V>,
): FitRule<Readonly<Record<string, V>>> {
	return (label) => {
		const fitValue = value(`${label}[]`);
		const tooMany = `${label} to ${maxFields} fields`;
		const nameTooLong = `${label} names over ${maxNameLength} characters dropped`;
		return (fields, trace) => {
			if (typeof fields !== 'object' || fields === null) return fields;
			if (Array.isArray(fields)) return fields;
			const names = Object.keys(fields);
			let copy: Record<string, V> | undefined;
			let kept = 0;
			for (let index = 0; index < names.length; index += 1) {
				const name = names[index] as string;
				const entry = fields[name] as V;
				const dropped =
					name.length > maxNameLength
						? nameTooLong
						: kept >= maxFields
							? tooMany
							: undefined;
				if (dropped) trace.add(dropped);
				else kept += 1;
				const next = dropped ? entry : fitValue(entry, trace);
				if (!dropped && next === entry && !copy) continue;
				if (!copy) {
					// The first difference: copy the fields kept so far, unchanged. A
					// map without a prototype keeps a field named `__proto__` as data.
					copy = Object.create(null) as Record<string, V>;
					for (let before = 0; before < index; before += 1) {
						const earlier = names[before] as string;
						copy[earlier] = fields[earlier] as V;
					}
				}
				if (!dropped) copy[name] = next;
			}
			return copy ?? fields;
		};
	};
}

const TIMESTAMP = finiteRange(0, NUMBERS.timestamp);
const NON_NEGATIVE = finiteRange(0, Number.POSITIVE_INFINITY);
const COUNT = integerRange(0, Number.MAX_SAFE_INTEGER);
const POSITIVE_COUNT = integerRange(1, Number.MAX_SAFE_INTEGER);

const identifier = fitTrimmedText(TEXT.identifier);
const shortText = fitText(TEXT.short);
const longText = fitText(TEXT.long);
const timestamp = fitNumber(TIMESTAMP);
const optionalTimestamp = fitOptionalNumber(TIMESTAMP);
const count = fitNumber(COUNT);
const optionalCount = fitOptionalNumber(COUNT);
const positiveCount = fitNumber(POSITIVE_COUNT);
const optionalPositiveCount = fitOptionalNumber(POSITIVE_COUNT);
const nonNegative = fitNumber(NON_NEGATIVE);
const optionalNonNegative = fitOptionalNumber(NON_NEGATIVE);

type Tools = DesktopDeviceToolsSnapshot;
type Row<K extends keyof Tools> = Tools[K] extends readonly (infer R)[]
	? R
	: never;
type Item<T> = NonNullable<T> extends readonly (infer R)[] ? R : never;

type ScenarioPrimitive = string | number | boolean | null;

/**
 * A scenario value: a text cut to its limit. A number that is not finite
 * becomes `null`, which is how JSON writes it.
 */
function fitScenarioValue<T extends ScenarioPrimitive | undefined>(
	label: string,
): Fit<T> {
	const change = `${label} to ${TEXT.scenario} characters`;
	const notFinite = `${label} to null (not a finite number)`;
	return (value, trace) => {
		if (typeof value === 'string' && value.length > TEXT.scenario) {
			trace.add(change);
			return cutText(value, TEXT.scenario) as T;
		}
		if (typeof value === 'number' && !Number.isFinite(value)) {
			trace.add(notFinite);
			return null as T;
		}
		return value;
	};
}

const headers = fitRecord<string>(
	EXTRA.headerFields,
	TEXT.headerName,
	longText,
);

const networkRow = fitObject<Row<'network'>>({
	id: identifier,
	at: timestamp,
	method: fitTrimmedText(TEXT.httpMethod),
	url: longText,
	host: shortText,
	path: longText,
	status: fitOptionalNumber(integerRange(0, NUMBERS.httpStatus)),
	state: keepAsIs,
	durationMs: optionalNonNegative,
	requestBytes: optionalCount,
	responseBytes: optionalCount,
	requestHeaders: fitOptional(headers),
	responseHeaders: fitOptional(headers),
	requestBody: longText,
	responseBody: longText,
	contentType: shortText,
	source: shortText,
	error: longText,
});

const consoleRow = fitObject<Row<'console'>>({
	id: identifier,
	at: timestamp,
	firstAt: optionalTimestamp,
	lastAt: optionalTimestamp,
	level: keepAsIs,
	message: longText,
	attributesText: longText,
	source: shortText,
	scope: shortText,
	correlationId: identifier,
	groupId: identifier,
	repeatCount: optionalPositiveCount,
	errorName: shortText,
	errorStack: longText,
	sourceLocation: fitOptional(
		fitObject<NonNullable<Row<'console'>['sourceLocation']>>({
			file: longText,
			line: optionalPositiveCount,
			column: optionalPositiveCount,
		}),
	),
});

const storageRow = fitObject<Row<'storage'>>({
	id: identifier,
	adapterId: identifier,
	adapterTitle: shortText,
	key: longText,
	valueText: longText,
	valueType: keepAsIs,
	bytes: count,
	sensitive: keepAsIs,
	editable: keepAsIs,
	updatedAt: optionalTimestamp,
});

const storageEventRow = fitObject<Row<'storageEvents'>>({
	id: identifier,
	at: timestamp,
	adapterId: identifier,
	key: longText,
	kind: keepAsIs,
	previousText: longText,
	nextText: longText,
	bookmarked: keepAsIs,
	undoAvailable: keepAsIs,
	undoStatus: keepAsIs,
	structuralDiff: fitOptional(
		fitList(
			EXTRA.storageStructuralDiff,
			'first',
			fitObject<Item<Row<'storageEvents'>['structuralDiff']>>({
				path: shortText,
				kind: keepAsIs,
				previousText: shortText,
				nextText: shortText,
			}),
		),
	),
});

const storageSummary = fitObject<Tools['storageSummary']>({
	adapterCount: count,
	totalKeyCount: count,
	omittedKeyCount: count,
	truncated: keepAsIs,
	errors: fitList(
		EXTRA.storageSummaryErrors,
		'first',
		fitObject<Item<Tools['storageSummary']['errors']>>({
			adapterId: identifier,
			adapterTitle: shortText,
			message: longText,
		}),
	),
});

const queryRow = fitObject<Row<'queries'>>({
	id: identifier,
	hash: longText,
	keyText: longText,
	status: keepAsIs,
	fetchStatus: keepAsIs,
	updatedAt: timestamp,
	observers: count,
	isStale: keepAsIs,
	dataText: longText,
	errorText: longText,
	truncated: keepAsIs,
});

const mutationRow = fitObject<Row<'mutations'>>({
	id: identifier,
	keyText: longText,
	status: keepAsIs,
	submittedAt: optionalTimestamp,
	variablesText: longText,
	errorText: longText,
	truncated: keepAsIs,
});

const querySummary = fitObject<Tools['querySummary']>({
	sourceQueryCount: count,
	omittedQueryCount: count,
	sourceMutationCount: count,
	omittedMutationCount: count,
	truncated: keepAsIs,
});

type QuerySimulation = NonNullable<Tools['querySimulation']>;
type SimulationFamily = QuerySimulation['families'][number];

/**
 * The simulation's active entry has to name a supported mode of a family that
 * is still listed, under the label the family has; one whose family was cut
 * away, or that never matched, is dropped.
 */
function keepMatchingActive(
	simulation: QuerySimulation,
	trace: FitTrace,
	label: string,
): QuerySimulation {
	const { active, families } = simulation;
	// Anything but an entry is left for the schema to judge.
	if (typeof active !== 'object' || active === null) return simulation;
	// The schema trims an identifier before it compares two.
	const sameId = (a: unknown, b: unknown) =>
		typeof a === 'string' && typeof b === 'string' && a.trim() === b.trim();
	const family = Array.isArray(families)
		? families.find((candidate: SimulationFamily | undefined) =>
				sameId(candidate?.id, active.familyId),
			)
		: undefined;
	const mode = Array.isArray(family?.modes)
		? family.modes.find(
				(candidate: SimulationFamily['modes'][number] | undefined) =>
					candidate?.mode === active.mode,
			)
		: undefined;
	if (family?.label === active.familyLabel && mode?.supported) {
		return simulation;
	}
	trace.add(`${label}.active dropped (it names no supported family mode)`);
	const { active: _dropped, ...rest } = simulation;
	return rest;
}

const querySimulation = fitObject<QuerySimulation>(
	{
		families: fitList(
			EXTRA.querySimulationFamilies,
			'first',
			fitObject<QuerySimulation['families'][number]>({
				id: identifier,
				label: shortText,
				description: longText,
				modes: fitList(
					EXTRA.querySimulationModes,
					'first',
					fitObject<QuerySimulation['families'][number]['modes'][number]>({
						mode: keepAsIs,
						supported: keepAsIs,
						reason: longText,
					}),
				),
			}),
		),
		active: fitOptional(
			fitObject<NonNullable<QuerySimulation['active']>>({
				familyId: identifier,
				familyLabel: shortText,
				mode: keepAsIs,
				receiptId: identifier,
				startedAt: timestamp,
			}),
		),
	},
	keepMatchingActive,
);

const routeRow = fitObject<Row<'routes'>>({
	id: identifier,
	path: longText,
	name: shortText,
	kind: keepAsIs,
	filename: longText,
	isCurrent: keepAsIs,
	isVisible: keepAsIs,
	depth: count,
});

const routeEventRow = fitObject<Row<'routeEvents'>>({
	id: identifier,
	at: timestamp,
	route: longText,
	metadataText: longText,
	transitionId: identifier,
	phase: keepAsIs,
	source: keepAsIs,
	correlationId: identifier,
	durationMs: optionalNonNegative,
	error: longText,
});

const environmentRow = fitObject<Row<'environment'>>({
	id: identifier,
	section: shortText,
	key: shortText,
	valueText: longText,
	status: keepAsIs,
	description: longText,
});

const zustandStoreRow = fitObject<Row<'zustandStores'>>({
	id: identifier,
	title: shortText,
	description: shortText,
	stateText: longText,
	// The schema caps a store's keys at the storage key limit.
	keys: fitList<string>(LIMITS.storageKeys, 'first', shortText),
	updatedAt: timestamp,
	capabilities: keepAsIs,
	error: longText,
});

const zustandChangeRow = fitObject<Row<'zustandChanges'>>({
	id: identifier,
	at: timestamp,
	storeId: identifier,
	storeTitle: shortText,
	changedKeys: fitList<string>(LIMITS.zustandChangedKeys, 'first', shortText),
	stateText: longText,
	error: longText,
});

const zustandStateSnapshotRow = fitObject<Row<'zustandStateSnapshots'>>({
	id: identifier,
	storeId: identifier,
	storeTitle: shortText,
	createdAt: timestamp,
	stateText: longText,
	stateBytes: fitNumber(integerRange(0, NUMBERS.zustandStateBytes)),
	truncated: keepAsIs,
});

const zustandMutationReceiptRow = fitObject<Row<'zustandMutationReceipts'>>({
	id: identifier,
	storeId: identifier,
	kind: keepAsIs,
	status: keepAsIs,
	startedAt: timestamp,
	completedAt: timestamp,
	changedKeys: fitList<string>(LIMITS.zustandChangedKeys, 'first', shortText),
	correlationId: identifier,
	snapshotId: identifier,
	error: longText,
});

const zustandSummary = fitObject<Tools['zustandSummary']>({
	totalStoreCount: count,
	omittedStoreCount: count,
	truncated: keepAsIs,
	error: longText,
});

const restorePointRow = fitObject<Row<'restorePoints'>>({
	id: identifier,
	label: shortText,
	createdAt: timestamp,
	estimatedBytes: count,
	sources: fitList(
		LIMITS.restoreSources,
		'first',
		fitObject<Item<Row<'restorePoints'>['sources']>>({
			id: identifier,
			title: shortText,
			preview: longText,
			bytes: count,
		}),
	),
});

const restoreReceiptRow = fitObject<Row<'restoreReceipts'>>({
	id: identifier,
	pointId: identifier,
	pointLabel: shortText,
	startedAt: timestamp,
	completedAt: timestamp,
	status: keepAsIs,
	error: longText,
	sourceResults: fitList(
		LIMITS.restoreSources,
		'first',
		fitObject<Item<Row<'restoreReceipts'>['sourceResults']>>({
			sourceId: identifier,
			sourceTitle: shortText,
			preflight: keepAsIs,
			apply: keepAsIs,
			rollback: keepAsIs,
			error: longText,
			rollbackError: longText,
		}),
	),
});

type ScenarioVariable = Item<Row<'scenarios'>['variables']>;

/** A default has to be of the variable's declared type, or the schema fails it. */
function dropMismatchedDefault(
	variable: ScenarioVariable,
	trace: FitTrace,
	label: string,
): ScenarioVariable {
	const { defaultValue } = variable;
	if (defaultValue === undefined || typeof defaultValue === variable.type) {
		return variable;
	}
	trace.add(`${label}.defaultValue dropped (it is not a ${variable.type})`);
	const { defaultValue: _dropped, ...rest } = variable;
	return rest;
}

const scenarioRow = fitObject<Row<'scenarios'>>({
	id: identifier,
	version: positiveCount,
	definitionToken: identifier,
	name: shortText,
	description: fitText(TEXT.scenario),
	bundled: keepAsIs,
	variables: fitList(
		LIMITS.scenarioVariables,
		'first',
		fitObject<ScenarioVariable>(
			{
				id: identifier,
				label: shortText,
				type: keepAsIs,
				required: keepAsIs,
				defaultValue: fitScenarioValue,
				options: fitOptional(
					fitList(
						EXTRA.scenarioVariableOptions,
						'first',
						fitScenarioValue<ScenarioPrimitive>,
					),
				),
			},
			dropMismatchedDefault,
		),
	),
	preconditionCount: count,
	steps: fitList(
		LIMITS.scenarioSteps,
		'first',
		fitObject<Item<Row<'scenarios'>['steps']>>({
			id: identifier,
			type: keepAsIs,
			label: shortText,
		}),
	),
});

const scenarioWarnings = fitList<string>(
	EXTRA.scenarioWarnings,
	'first',
	shortText,
);

const scenarioRuntime = fitObject<Tools['scenarioRuntime']>({
	running: keepAsIs,
	recoveryError: longText,
	active: fitOptional(
		fitObject<NonNullable<Tools['scenarioRuntime']['active']>>({
			receiptId: identifier,
			scenarioId: identifier,
			scenarioVersion: positiveCount,
			scenarioName: shortText,
			activatedAt: timestamp,
			stepCount: count,
			privileged: keepAsIs,
			warnings: scenarioWarnings,
			recoveryRequired: keepAsIs,
		}),
	),
});

const scenarioReceiptRow = fitObject<Row<'scenarioReceipts'>>({
	id: identifier,
	scenarioId: identifier,
	scenarioVersion: positiveCount,
	scenarioName: shortText,
	startedAt: timestamp,
	completedAt: timestamp,
	status: keepAsIs,
	error: longText,
	stepResults: fitList(
		LIMITS.scenarioSteps,
		'first',
		fitObject<Item<Row<'scenarioReceipts'>['stepResults']>>({
			stepId: identifier,
			stepType: keepAsIs,
			label: shortText,
			preflight: keepAsIs,
			apply: keepAsIs,
			rollback: keepAsIs,
			reversible: keepAsIs,
			privileged: keepAsIs,
			warnings: fitOptional(scenarioWarnings),
			summary: shortText,
			error: longText,
			rollbackError: longText,
		}),
	),
});

/** Only a persona identity carries a persona identifier. */
function dropStrayPersonaId(
	who: DesktopIdentitySnapshot,
	trace: FitTrace,
	label: string,
): DesktopIdentitySnapshot {
	if (who.kind === 'persona' || who.personaId === undefined) return who;
	trace.add(`${label}.personaId dropped (only a persona has one)`);
	const { personaId: _dropped, ...rest } = who;
	return rest;
}

const identity = fitObject<DesktopIdentitySnapshot>(
	{ kind: keepAsIs, label: shortText, personaId: identifier },
	dropStrayPersonaId,
);

const identitySession = fitObject<Tools['identitySession']>({
	running: keepAsIs,
	active: fitOptional(
		fitObject<NonNullable<Tools['identitySession']['active']>>({
			historyId: identifier,
			startedAt: timestamp,
			actor: identity,
			target: identity,
			status: keepAsIs,
			error: longText,
		}),
	),
	// The contract does not say which end is newest, and the reference device
	// lists the newest session first, so rank by when a session started.
	history: fitList(
		LIMITS.identityHistory,
		latestBy<Item<Tools['identitySession']['history']>>((row) => row.startedAt),
		fitObject<Item<Tools['identitySession']['history']>>({
			id: identifier,
			startedAt: timestamp,
			stoppedAt: optionalTimestamp,
			actor: identity,
			target: identity,
			status: keepAsIs,
			error: longText,
		}),
	),
	personas: fitList(
		LIMITS.identityPersonas,
		'first',
		fitObject<Item<Tools['identitySession']['personas']>>({
			id: identifier,
			label: shortText,
			note: shortText,
		}),
	),
});

const fps = fitNumber(finiteRange(0, NUMBERS.fps));
const optionalFps = fitOptionalNumber(finiteRange(0, NUMBERS.fps));

const performanceFields = fitObject<Tools['performance']>({
	isActive: keepAsIs,
	startedAt: fitNullableNumber(TIMESTAMP),
	stoppedAt: fitNullableNumber(TIMESTAMP),
	error: longText,
	droppedSampleCount: count,
	samples: fitList(
		LIMITS.performanceSamples,
		'newest',
		fitObject<DesktopPerformanceSampleSnapshot>({
			id: identifier,
			at: timestamp,
			jsFps: fps,
			uiFps: optionalFps,
			cpuPercent: fitOptionalNumber(finiteRange(0, NUMBERS.cpuPercent)),
			memoryMb: optionalNonNegative,
			eventLoopLagMs: nonNegative,
			longFrames: count,
			maxFrameMs: nonNegative,
			route: longText,
		}),
	),
	summary: fitObject<Tools['performance']['summary']>({
		grade: keepAsIs,
		durationMs: nonNegative,
		sampleCount: count,
		averageJsFps: nonNegative,
		averageUiFps: optionalNonNegative,
		averageEventLoopLagMs: nonNegative,
		p95EventLoopLagMs: nonNegative,
		maxEventLoopLagMs: nonNegative,
		longFrameCount: count,
	}),
});

/**
 * The performance panel says samples were dropped only when its counter is
 * above zero, so a cut that removes samples raises the counter by that many.
 */
const performanceReview: FitRule<Tools['performance']> = (label) => {
	const fit = performanceFields(label);
	return (value, trace) => {
		const fitted = fit(value, trace);
		if (
			fitted === value ||
			typeof value !== 'object' ||
			value === null ||
			!Array.isArray(value.samples) ||
			!Array.isArray(fitted.samples) ||
			typeof fitted.droppedSampleCount !== 'number'
		) {
			return fitted;
		}
		const removed = value.samples.length - fitted.samples.length;
		if (removed <= 0) return fitted;
		trace.add(
			`${label ? `${label}.` : ''}droppedSampleCount raised for the samples cut`,
		);
		return {
			...fitted,
			droppedSampleCount: Math.min(
				Number.MAX_SAFE_INTEGER,
				fitted.droppedSampleCount + removed,
			),
		};
	};
};

const coordinate = fitNumber(
	finiteRange(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY),
);

type ComponentAction = NonNullable<Row<'components'>['actions']>[number];

const componentRow = fitObject<Row<'components'>>({
	id: identifier,
	targetId: identifier,
	parentId: identifier,
	depth: fitOptionalNumber(integerRange(0, NUMBERS.componentDepth)),
	zIndex: fitOptionalNumber(
		finiteRange(-NUMBERS.componentZIndex, NUMBERS.componentZIndex),
	),
	name: shortText,
	kind: shortText,
	feature: shortText,
	route: longText,
	testID: shortText,
	targetKey: shortText,
	sourceFiles: fitList<string>(LIMITS.componentSourceFiles, 'first', longText),
	instanceText: longText,
	instanceTruncated: keepAsIs,
	bounds: fitNullable(
		fitObject<NonNullable<Row<'components'>['bounds']>>({
			x: coordinate,
			y: coordinate,
			width: nonNegative,
			height: nonNegative,
		}),
	),
	isFocused: keepAsIs,
	accessibilityLabel: shortText,
	accessibilityHint: shortText,
	accessibilityRole: shortText,
	accessibilityValue: shortText,
	accessibilityState: fitOptional(
		fitRecord<boolean | string>(
			EXTRA.accessibilityStateFields,
			TEXT.short,
			shortText,
		),
	),
	styleText: longText,
	styleTruncated: keepAsIs,
	actions: fitOptional(
		fitList<ComponentAction>(EXTRA.componentActions, 'first', keepAsIs),
	),
	screenHash: identifier,
});

const renderDuration = fitNumber(finiteRange(0, NUMBERS.renderDurationMs));

const componentRenderRow = fitObject<Row<'componentRenders'>>({
	id: identifier,
	targetId: identifier,
	at: timestamp,
	phase: keepAsIs,
	actualDuration: renderDuration,
	baseDuration: renderDuration,
	startTime: timestamp,
	commitTime: timestamp,
	renderCount: fitNumber(integerRange(1, NUMBERS.renderCount)),
	cause: keepAsIs,
	changedKeys: fitList<string>(
		EXTRA.componentRenderChangedKeys,
		'first',
		shortText,
	),
});

const componentSummary = fitObject<Tools['componentSummary']>({
	sourceTargetCount: count,
	omittedTargetCount: count,
	truncated: keepAsIs,
	screenHash: identifier,
	registrationDiagnostics: fitOptional(
		fitList(
			LIMITS.componentDiagnostics,
			'first',
			fitObject<Item<Tools['componentSummary']['registrationDiagnostics']>>({
				code: keepAsIs,
				targetId: identifier,
				instanceIds: fitList<string>(LIMITS.components, 'first', identifier),
				message: longText,
			}),
		),
	),
	error: longText,
});

type CameraFixture = DesktopCameraFixtureSnapshot;

/** Mirrors the schema's check that a camera fixture's metadata agrees. */
function isConsistentCameraFixture(fixture: CameraFixture): boolean {
	const { active, kind, mimeType, bytes, width, height, durationMs } = fixture;
	if (!active) {
		return [
			kind,
			fixture.label,
			mimeType,
			bytes,
			width,
			height,
			durationMs,
		].every((detail) => detail === undefined);
	}
	if (!kind) return false;
	if (kind === 'unavailable' || kind === 'error') {
		return [mimeType, bytes, width, height, durationMs].every(
			(detail) => detail === undefined,
		);
	}
	if (
		mimeType === undefined ||
		bytes === undefined ||
		bytes <= 0 ||
		width === undefined ||
		height === undefined
	) {
		return false;
	}
	if (kind === 'video') {
		return (
			(mimeType === 'video/mp4' || mimeType === 'video/quicktime') &&
			durationMs !== undefined
		);
	}
	return (
		(mimeType === 'image/jpeg' ||
			mimeType === 'image/png' ||
			mimeType === 'image/webp') &&
		durationMs === undefined
	);
}

/**
 * A fixture whose metadata disagrees, or lost a number to the fit, is reported
 * as no fixture rather than rejected with the whole snapshot.
 */
function resetInconsistentCameraFixture(
	fixture: CameraFixture,
	trace: FitTrace,
	label: string,
): CameraFixture {
	if (isConsistentCameraFixture(fixture)) return fixture;
	trace.add(`${label} reset (its metadata is inconsistent)`);
	return { active: false };
}

const cameraFixture = fitObject<CameraFixture>(
	{
		active: keepAsIs,
		kind: keepAsIs,
		label: shortText,
		mimeType: keepAsIs,
		bytes: fitOptionalNumber(integerRange(0, NUMBERS.cameraFixtureBytes)),
		width: fitOptionalNumber(integerRange(1, NUMBERS.cameraFixtureDimension)),
		height: fitOptionalNumber(integerRange(1, NUMBERS.cameraFixtureDimension)),
		durationMs: fitOptionalNumber(
			integerRange(1, NUMBERS.cameraFixtureDurationMs),
		),
	},
	resetInconsistentCameraFixture,
);

const diagnosticRow = fitObject<Row<'diagnostics'>>({
	id: identifier,
	at: timestamp,
	level: keepAsIs,
	scope: shortText,
	message: longText,
});

const snapshotRule = fitObject<Tools>({
	network: fitList(LIMITS.network, 'newest', networkRow),
	networkProfile: fitOptional(
		fitObject<NonNullable<Tools['networkProfile']>>({
			id: keepAsIs,
			name: shortText,
			active: keepAsIs,
			scope: keepAsIs,
		}),
	),
	console: fitList(LIMITS.console, 'newest', consoleRow),
	storage: fitList(LIMITS.storage, 'newest', storageRow),
	storageEvents: fitList(LIMITS.storageEvents, 'newest', storageEventRow),
	storageSummary,
	queries: fitList(LIMITS.queries, 'newest', queryRow),
	mutations: fitList(LIMITS.mutations, 'newest', mutationRow),
	querySummary,
	querySimulation: fitOptional(querySimulation),
	routes: fitList(LIMITS.routes, 'newest', routeRow),
	routeEvents: fitList(LIMITS.routeEvents, 'newest', routeEventRow),
	environment: fitList(LIMITS.environment, 'newest', environmentRow),
	zustandStores: fitList(LIMITS.zustandStores, 'newest', zustandStoreRow),
	zustandChanges: fitList(LIMITS.zustandChanges, 'newest', zustandChangeRow),
	zustandStateSnapshots: fitList(
		LIMITS.zustandStateSnapshots,
		'newest',
		zustandStateSnapshotRow,
	),
	zustandMutationReceipts: fitList(
		LIMITS.zustandMutationReceipts,
		'newest',
		zustandMutationReceiptRow,
	),
	zustandSummary,
	restorePoints: fitList(LIMITS.restorePoints, 'newest', restorePointRow),
	restoreReceipts: fitList(LIMITS.restoreReceipts, 'newest', restoreReceiptRow),
	scenarios: fitList(LIMITS.scenarios, 'newest', scenarioRow),
	scenarioRuntime,
	scenarioReceipts: fitList(
		LIMITS.scenarioReceipts,
		'newest',
		scenarioReceiptRow,
	),
	identitySession,
	performance: performanceReview,
	components: fitList(LIMITS.components, 'newest', componentRow),
	componentRenders: fitList(
		LIMITS.componentRenders,
		'newest',
		componentRenderRow,
	),
	componentSummary,
	cameraFixture: fitOptional(cameraFixture),
	diagnostics: fitList(LIMITS.diagnostics, 'newest', diagnosticRow),
});

let fitSnapshot: Fit<DesktopDeviceToolsSnapshot> | undefined;

/**
 * Fits a snapshot to everything the desktop schema bounds, so the broker
 * takes it instead of closing the socket: the rows of every list, nested ones
 * included, the fields of every map, the length of every text and the range
 * of every number. The schema reads its bounds from the tables above, so the
 * two agree.
 *
 * A top-level list over its cap keeps its last rows, as core's stores
 * append. A list inside a row keeps its newest rows if it is chronological
 * and its first rows if it is ordered, such as keys, sources, variables, steps
 * and files; the identity history keeps the sessions that started latest. A map keeps its first fields and loses
 * any whose name is too long. A text is cut to its limit without splitting a
 * surrogate pair. A number is clamped into its range and an integer's
 * fraction cut off; one that is not finite is dropped if it is optional,
 * written as `null` if it is nullable, as JSON would, and made its lower
 * bound, or 0 where there is none, if it is required. The desktop redacts, so
 * this only bounds.
 *
 * What a bound can leave disagreeing is dropped or reset, since the schema
 * would reject the whole snapshot for it: a query simulation's active entry
 * whose family the cap cut away, a camera fixture whose metadata disagrees, a
 * scenario variable default that is not of the variable's type, and a persona
 * identifier on an identity that is not a persona. What else is wrong with a
 * snapshot, such as a missing or unexpected field, a value of the wrong type
 * or an unknown enum value, is left for the schema, and the fit does not
 * throw on it.
 *
 * Returns `tools` itself when nothing had to change, and otherwise shares
 * every row it did not change with `tools`. `trimmed` describes each change
 * once, in the order met, as a path and what it was cut to, for example
 * `network to 2000 rows` or `components[].sourceFiles to 20 rows`.
 */
export function fitDesktopSnapshot(tools: DesktopDeviceToolsSnapshot): {
	tools: DesktopDeviceToolsSnapshot;
	trimmed: readonly string[];
} {
	fitSnapshot ??= snapshotRule('');
	const trace: FitTrace = new Set();
	const fitted = fitSnapshot(tools, trace);
	return { tools: fitted, trimmed: [...trace] };
}
