import {
	type DesktopDeviceToolsSnapshot,
	RNDEVTOOLS_SNAPSHOT_EXTRA_LIMITS as EXTRA,
	fitDesktopSnapshot,
	RNDEVTOOLS_SNAPSHOT_LIMITS as LIMITS,
	RNDEVTOOLS_SNAPSHOT_NUMBER_LIMITS as NUMBERS,
	RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS as TEXT,
} from '@rndevtools/core/desktop-protocol';
import { describe, expect, it } from 'vitest';
import { deviceSnapshotMessageSchema } from './protocol';

// The mobile client fits every snapshot with `fitDesktopSnapshot` before it
// sends one, and the broker closes the socket on one that fails
// `deviceSnapshotMessageSchema`. This file holds the two to each other: every
// field that carries a bound is listed below, with the bound the schema is
// meant to apply, and each one is pushed past it.

type Tools = DesktopDeviceToolsSnapshot;

/** The contract with every optional field present, so the sample cannot miss one. */
type Complete<T> = T extends readonly (infer R)[]
	? readonly Complete<R>[]
	: T extends object
		? { [K in keyof T]-?: Complete<NonNullable<T[K]>> }
		: T;

const NOW = 1_700_000_000_000;

const persona = {
	kind: 'persona',
	label: 'Alex',
	personaId: 'persona-1',
} as const;

/** Frozen, so a test that edits the sample itself instead of a copy fails. */
function deepFreeze<T>(value: T): T {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

/** Valid in every field, every optional one included, with one row per list. */
const SAMPLE: Complete<DesktopDeviceToolsSnapshot> = deepFreeze({
	network: [
		{
			id: 'request-1',
			at: NOW,
			method: 'GET',
			url: 'https://example.com/items',
			host: 'example.com',
			path: '/items',
			status: 200,
			state: 'success',
			durationMs: 12.5,
			requestBytes: 0,
			responseBytes: 2_048,
			requestHeaders: { accept: 'application/json' },
			responseHeaders: { 'content-type': 'application/json' },
			requestBody: '{}',
			responseBody: '[]',
			contentType: 'application/json',
			source: 'fetch',
			error: 'none',
		},
	],
	networkProfile: {
		id: '3g',
		name: 'Slow 3G',
		active: true,
		scope: 'instrumented-fetch',
	},
	console: [
		{
			id: 'log-1',
			at: NOW,
			firstAt: NOW,
			lastAt: NOW + 1,
			level: 'warn',
			message: 'Something happened',
			attributesText: 'a=1',
			source: 'app',
			scope: 'ui',
			correlationId: 'correlation-1',
			groupId: 'group-1',
			repeatCount: 2,
			errorName: 'Error',
			errorStack: 'Error: Something happened',
			sourceLocation: { file: 'App.tsx', line: 10, column: 4 },
		},
	],
	storage: [
		{
			id: 'entry-1',
			adapterId: 'async-storage',
			adapterTitle: 'AsyncStorage',
			key: 'theme',
			valueText: 'dark',
			valueType: 'string',
			bytes: 4,
			sensitive: false,
			editable: true,
			updatedAt: NOW,
		},
	],
	storageEvents: [
		{
			id: 'event-1',
			at: NOW,
			adapterId: 'async-storage',
			key: 'theme',
			kind: 'updated',
			previousText: 'light',
			nextText: 'dark',
			bookmarked: false,
			undoAvailable: true,
			undoStatus: 'available',
			structuralDiff: [
				{
					path: '$.theme',
					kind: 'changed',
					previousText: 'light',
					nextText: 'dark',
				},
			],
		},
	],
	storageSummary: {
		adapterCount: 1,
		totalKeyCount: 1,
		omittedKeyCount: 0,
		truncated: false,
		errors: [
			{
				adapterId: 'secure-store',
				adapterTitle: 'SecureStore',
				message: 'Not listed',
			},
		],
	},
	queries: [
		{
			id: 'query-1',
			hash: 'hash-1',
			keyText: 'items',
			status: 'success',
			fetchStatus: 'idle',
			updatedAt: NOW,
			observers: 1,
			isStale: false,
			dataText: '[]',
			errorText: 'none',
			truncated: false,
		},
	],
	mutations: [
		{
			id: 'mutation-1',
			keyText: 'save',
			status: 'success',
			submittedAt: NOW,
			variablesText: '{}',
			errorText: 'none',
			truncated: false,
		},
	],
	querySummary: {
		sourceQueryCount: 1,
		omittedQueryCount: 0,
		sourceMutationCount: 1,
		omittedMutationCount: 0,
		truncated: false,
	},
	querySimulation: {
		families: [
			{
				id: 'items',
				label: 'Items',
				description: 'Every items query',
				modes: [
					{ mode: 'loading', supported: true, reason: 'Held in flight' },
					{ mode: 'error', supported: true, reason: 'Rejected' },
					{ mode: 'paused', supported: true, reason: 'Paused' },
					{ mode: 'offline', supported: false, reason: 'Needs a network' },
				],
			},
		],
		active: {
			familyId: 'items',
			familyLabel: 'Items',
			mode: 'loading',
			receiptId: 'simulation-1',
			startedAt: NOW,
		},
	},
	routes: [
		{
			id: 'route-1',
			path: '/settings',
			name: 'settings',
			kind: 'static',
			filename: 'settings.tsx',
			isCurrent: true,
			isVisible: true,
			depth: 1,
		},
	],
	routeEvents: [
		{
			id: 'route-event-1',
			at: NOW,
			route: '/settings',
			metadataText: '{}',
			transitionId: 'transition-1',
			phase: 'committed',
			source: 'app',
			correlationId: 'correlation-1',
			durationMs: 30,
			error: 'none',
		},
	],
	environment: [
		{
			id: 'env-1',
			section: 'public',
			key: 'API_ORIGIN',
			valueText: 'https://example.com',
			status: 'valid',
			description: 'Where the API lives',
		},
	],
	zustandStores: [
		{
			id: 'store-1',
			title: 'Settings',
			description: 'App settings',
			stateText: '{"theme":"dark"}',
			keys: ['theme'],
			updatedAt: NOW,
			capabilities: {
				writable: true,
				resettable: true,
				persisted: false,
				restorable: true,
			},
			error: 'none',
		},
	],
	zustandChanges: [
		{
			id: 'change-1',
			at: NOW,
			storeId: 'store-1',
			storeTitle: 'Settings',
			changedKeys: ['theme'],
			stateText: '{"theme":"dark"}',
			error: 'none',
		},
	],
	zustandStateSnapshots: [
		{
			id: 'state-1',
			storeId: 'store-1',
			storeTitle: 'Settings',
			createdAt: NOW,
			stateText: '{"theme":"dark"}',
			stateBytes: 16,
			truncated: false,
		},
	],
	zustandMutationReceipts: [
		{
			id: 'mutation-receipt-1',
			storeId: 'store-1',
			kind: 'patch',
			status: 'succeeded',
			startedAt: NOW,
			completedAt: NOW + 1,
			changedKeys: ['theme'],
			correlationId: 'correlation-1',
			snapshotId: 'state-1',
			error: 'none',
		},
	],
	zustandSummary: {
		totalStoreCount: 1,
		omittedStoreCount: 0,
		truncated: false,
		error: 'none',
	},
	restorePoints: [
		{
			id: 'point-1',
			label: 'Before repro',
			createdAt: NOW,
			estimatedBytes: 64,
			sources: [{ id: 'source-1', title: 'Settings', preview: '{}', bytes: 2 }],
		},
	],
	restoreReceipts: [
		{
			id: 'restore-1',
			pointId: 'point-1',
			pointLabel: 'Before repro',
			startedAt: NOW,
			completedAt: NOW + 1,
			status: 'complete',
			error: 'none',
			sourceResults: [
				{
					sourceId: 'source-1',
					sourceTitle: 'Settings',
					preflight: 'passed',
					apply: 'succeeded',
					rollback: 'not-needed',
					error: 'none',
					rollbackError: 'none',
				},
			],
		},
	],
	scenarios: [
		{
			id: 'scenario-1',
			version: 1,
			definitionToken: 'definition-1',
			name: 'Power user',
			description: 'A user with many items',
			bundled: true,
			variables: [
				{
					id: 'plan',
					label: 'Plan',
					type: 'string',
					required: false,
					defaultValue: 'pro',
					options: ['free', 'pro'],
				},
			],
			preconditionCount: 0,
			steps: [{ id: 'step-1', type: 'navigation', label: 'Open settings' }],
		},
	],
	scenarioRuntime: {
		running: true,
		recoveryError: 'none',
		active: {
			receiptId: 'receipt-1',
			scenarioId: 'scenario-1',
			scenarioVersion: 1,
			scenarioName: 'Power user',
			activatedAt: NOW,
			stepCount: 1,
			privileged: false,
			warnings: ['Replaces the stored plan'],
			recoveryRequired: false,
		},
	},
	scenarioReceipts: [
		{
			id: 'receipt-1',
			scenarioId: 'scenario-1',
			scenarioVersion: 1,
			scenarioName: 'Power user',
			startedAt: NOW,
			completedAt: NOW + 1,
			status: 'complete',
			error: 'none',
			stepResults: [
				{
					stepId: 'step-1',
					stepType: 'navigation',
					label: 'Open settings',
					preflight: 'passed',
					apply: 'succeeded',
					rollback: 'not-needed',
					reversible: true,
					privileged: false,
					warnings: ['Leaves the current screen'],
					summary: 'Opened',
					error: 'none',
					rollbackError: 'none',
				},
			],
		},
	],
	identitySession: {
		running: true,
		active: {
			historyId: 'history-1',
			startedAt: NOW,
			actor: persona,
			target: persona,
			status: 'active',
			error: 'none',
		},
		history: [
			{
				id: 'history-1',
				startedAt: NOW,
				stoppedAt: NOW + 1,
				actor: persona,
				target: persona,
				status: 'stopped',
				error: 'none',
			},
		],
		personas: [{ id: 'persona-1', label: 'Alex', note: 'Onboarded' }],
	},
	performance: {
		isActive: true,
		startedAt: NOW,
		stoppedAt: NOW + 1_000,
		error: 'none',
		droppedSampleCount: 0,
		samples: [
			{
				id: 'sample-1',
				at: NOW,
				jsFps: 59.5,
				uiFps: 60,
				cpuPercent: 12.5,
				memoryMb: 140.25,
				eventLoopLagMs: 3.5,
				longFrames: 1,
				maxFrameMs: 18.25,
				route: '/settings',
			},
		],
		summary: {
			grade: 'healthy',
			durationMs: 1_000,
			sampleCount: 1,
			averageJsFps: 59.5,
			averageUiFps: 60,
			averageEventLoopLagMs: 3.5,
			p95EventLoopLagMs: 3.5,
			maxEventLoopLagMs: 3.5,
			longFrameCount: 1,
		},
	},
	components: [
		{
			id: 'component-1',
			targetId: 'target-1',
			parentId: 'target-0',
			depth: 2,
			zIndex: 1.5,
			name: 'Button',
			kind: 'Pressable',
			feature: 'settings',
			route: '/settings',
			testID: 'save-button',
			targetKey: 'save',
			sourceFiles: ['src/Button.tsx'],
			instanceText: '<Button />',
			instanceTruncated: false,
			bounds: { x: 0, y: -4.5, width: 120, height: 44 },
			isFocused: false,
			accessibilityLabel: 'Save',
			accessibilityHint: 'Saves the form',
			accessibilityRole: 'button',
			accessibilityValue: 'enabled',
			accessibilityState: { disabled: false, selected: 'no' },
			styleText: '{"flex":1}',
			styleTruncated: false,
			actions: ['activate', 'focus', 'setText', 'scroll'],
			screenHash: 'screen-1',
		},
	],
	componentRenders: [
		{
			id: 'render-1',
			targetId: 'target-1',
			at: NOW,
			phase: 'update',
			actualDuration: 1.5,
			baseDuration: 2.5,
			startTime: NOW,
			commitTime: NOW + 2,
			renderCount: 3,
			cause: 'props',
			changedKeys: ['title'],
		},
	],
	componentSummary: {
		sourceTargetCount: 1,
		omittedTargetCount: 0,
		truncated: false,
		screenHash: 'screen-1',
		registrationDiagnostics: [
			{
				code: 'duplicate-target-id',
				targetId: 'target-1',
				instanceIds: ['component-1'],
				message: 'Registered twice',
			},
		],
		error: 'none',
	},
	cameraFixture: {
		active: true,
		kind: 'video',
		label: 'Clip',
		mimeType: 'video/mp4',
		bytes: 1_024,
		width: 640,
		height: 480,
		durationMs: 5_000,
	},
	diagnostics: [
		{
			id: 'diagnostic-1',
			at: NOW,
			level: 'info',
			scope: 'client',
			message: 'Connected',
		},
	],
});

const paths = (names: string): string[] => names.trim().split(/\s+/);

// Paths read like the descriptions `fitDesktopSnapshot` returns: `[]` is a row
// of a list, and the first one is where the sample is edited. A trailing `?`
// marks an optional number and a trailing `!` one that can be null.

/** Texts the schema bounds by length. A trimmed one counts after trimming. */
const TEXT_FIELDS: readonly (readonly [limit: number, paths: string[]])[] = [
	[
		TEXT.identifier,
		paths(`
			network[].id
			console[].id console[].correlationId console[].groupId
			storage[].id storage[].adapterId
			storageEvents[].id storageEvents[].adapterId
			storageSummary.errors[].adapterId
			queries[].id
			mutations[].id
			querySimulation.families[].id querySimulation.active.familyId
			querySimulation.active.receiptId
			routes[].id
			routeEvents[].id routeEvents[].transitionId routeEvents[].correlationId
			environment[].id
			zustandStores[].id
			zustandChanges[].id zustandChanges[].storeId
			zustandStateSnapshots[].id zustandStateSnapshots[].storeId
			zustandMutationReceipts[].id zustandMutationReceipts[].storeId
			zustandMutationReceipts[].correlationId zustandMutationReceipts[].snapshotId
			restorePoints[].id restorePoints[].sources[].id
			restoreReceipts[].id restoreReceipts[].pointId
			restoreReceipts[].sourceResults[].sourceId
			scenarios[].id scenarios[].definitionToken
			scenarios[].variables[].id scenarios[].steps[].id
			scenarioRuntime.active.receiptId scenarioRuntime.active.scenarioId
			scenarioReceipts[].id scenarioReceipts[].scenarioId
			scenarioReceipts[].stepResults[].stepId
			identitySession.active.historyId
			identitySession.active.actor.personaId identitySession.active.target.personaId
			identitySession.history[].id
			identitySession.history[].actor.personaId identitySession.history[].target.personaId
			identitySession.personas[].id
			performance.samples[].id
			components[].id components[].targetId components[].parentId components[].screenHash
			componentRenders[].id componentRenders[].targetId
			componentSummary.screenHash componentSummary.registrationDiagnostics[].targetId
			componentSummary.registrationDiagnostics[].instanceIds[]
			diagnostics[].id
		`),
	],
	[TEXT.httpMethod, ['network[].method']],
	[
		TEXT.short,
		paths(`
			network[].host network[].contentType network[].source
			networkProfile.name
			console[].source console[].scope console[].errorName
			storage[].adapterTitle
			storageEvents[].structuralDiff[].path
			storageEvents[].structuralDiff[].previousText
			storageEvents[].structuralDiff[].nextText
			storageSummary.errors[].adapterTitle
			querySimulation.families[].label querySimulation.active.familyLabel
			routes[].name
			environment[].section environment[].key
			zustandStores[].title zustandStores[].description zustandStores[].keys[]
			zustandChanges[].storeTitle zustandChanges[].changedKeys[]
			zustandStateSnapshots[].storeTitle
			zustandMutationReceipts[].changedKeys[]
			restorePoints[].label restorePoints[].sources[].title
			restoreReceipts[].pointLabel restoreReceipts[].sourceResults[].sourceTitle
			scenarios[].name scenarios[].variables[].label scenarios[].steps[].label
			scenarioRuntime.active.scenarioName scenarioRuntime.active.warnings[]
			scenarioReceipts[].scenarioName scenarioReceipts[].stepResults[].label
			scenarioReceipts[].stepResults[].warnings[]
			scenarioReceipts[].stepResults[].summary
			identitySession.active.actor.label identitySession.active.target.label
			identitySession.history[].actor.label identitySession.history[].target.label
			identitySession.personas[].label identitySession.personas[].note
			components[].name components[].kind components[].feature
			components[].testID components[].targetKey
			components[].accessibilityLabel components[].accessibilityHint
			components[].accessibilityRole components[].accessibilityValue
			componentRenders[].changedKeys[]
			diagnostics[].scope
			cameraFixture.label
		`),
	],
	[
		TEXT.long,
		paths(`
			network[].url network[].path network[].requestBody network[].responseBody
			network[].error
			console[].message console[].attributesText console[].errorStack
			console[].sourceLocation.file
			storage[].key storage[].valueText
			storageEvents[].key storageEvents[].previousText storageEvents[].nextText
			storageSummary.errors[].message
			queries[].hash queries[].keyText queries[].dataText queries[].errorText
			mutations[].keyText mutations[].variablesText mutations[].errorText
			querySimulation.families[].description
			querySimulation.families[].modes[].reason
			routes[].path routes[].filename
			routeEvents[].route routeEvents[].metadataText routeEvents[].error
			environment[].valueText environment[].description
			zustandStores[].stateText zustandStores[].error
			zustandChanges[].stateText zustandChanges[].error
			zustandStateSnapshots[].stateText
			zustandMutationReceipts[].error
			zustandSummary.error
			restorePoints[].sources[].preview
			restoreReceipts[].error restoreReceipts[].sourceResults[].error
			restoreReceipts[].sourceResults[].rollbackError
			scenarioRuntime.recoveryError
			scenarioReceipts[].error scenarioReceipts[].stepResults[].error
			scenarioReceipts[].stepResults[].rollbackError
			identitySession.active.error identitySession.history[].error
			performance.error performance.samples[].route
			components[].route components[].instanceText components[].styleText
			components[].sourceFiles[]
			componentSummary.registrationDiagnostics[].message componentSummary.error
			diagnostics[].message
		`),
	],
	[
		TEXT.scenario,
		paths(`
			scenarios[].description scenarios[].variables[].defaultValue
			scenarios[].variables[].options[]
		`),
	],
];

/** Strings the schema takes only from a fixed set, so no length bounds them. */
const ENUM_FIELDS = paths(`
	network[].state networkProfile.id networkProfile.scope
	console[].level
	storage[].valueType storageEvents[].kind storageEvents[].undoStatus
	storageEvents[].structuralDiff[].kind
	queries[].status queries[].fetchStatus mutations[].status
	querySimulation.families[].modes[].mode querySimulation.active.mode
	routes[].kind routeEvents[].phase routeEvents[].source
	environment[].status
	zustandMutationReceipts[].kind zustandMutationReceipts[].status
	restoreReceipts[].status restoreReceipts[].sourceResults[].preflight
	restoreReceipts[].sourceResults[].apply restoreReceipts[].sourceResults[].rollback
	scenarios[].variables[].type scenarios[].steps[].type
	scenarioReceipts[].status scenarioReceipts[].stepResults[].stepType
	scenarioReceipts[].stepResults[].preflight scenarioReceipts[].stepResults[].apply
	scenarioReceipts[].stepResults[].rollback
	identitySession.active.actor.kind identitySession.active.target.kind
	identitySession.active.status
	identitySession.history[].actor.kind identitySession.history[].target.kind
	identitySession.history[].status
	performance.summary.grade
	components[].actions[]
	componentRenders[].phase componentRenders[].cause
	componentSummary.registrationDiagnostics[].code
	cameraFixture.kind cameraFixture.mimeType
	diagnostics[].level
`);

type Range = Readonly<{ min: number; max: number; integer: boolean }>;
const finite = (min: number, max: number): Range => ({
	min,
	max,
	integer: false,
});
const integer = (min: number, max: number): Range => ({
	min,
	max,
	integer: true,
});

/** Numbers the schema bounds, whether by a range or by being finite alone. */
const NUMBER_FIELDS: readonly (readonly [range: Range, paths: string[]])[] = [
	[
		finite(0, NUMBERS.timestamp),
		paths(`
			network[].at console[].at console[].firstAt? console[].lastAt?
			storage[].updatedAt? storageEvents[].at
			queries[].updatedAt mutations[].submittedAt?
			querySimulation.active.startedAt routeEvents[].at
			zustandStores[].updatedAt zustandChanges[].at zustandStateSnapshots[].createdAt
			zustandMutationReceipts[].startedAt zustandMutationReceipts[].completedAt
			restorePoints[].createdAt restoreReceipts[].startedAt restoreReceipts[].completedAt
			scenarioRuntime.active.activatedAt
			scenarioReceipts[].startedAt scenarioReceipts[].completedAt
			identitySession.active.startedAt identitySession.history[].startedAt
			identitySession.history[].stoppedAt?
			performance.startedAt! performance.stoppedAt! performance.samples[].at
			componentRenders[].at componentRenders[].startTime componentRenders[].commitTime
			diagnostics[].at
		`),
	],
	[
		integer(0, Number.MAX_SAFE_INTEGER),
		paths(`
			network[].requestBytes? network[].responseBytes? storage[].bytes
			storageSummary.adapterCount storageSummary.totalKeyCount
			storageSummary.omittedKeyCount
			queries[].observers
			querySummary.sourceQueryCount querySummary.omittedQueryCount
			querySummary.sourceMutationCount querySummary.omittedMutationCount
			routes[].depth
			zustandSummary.totalStoreCount zustandSummary.omittedStoreCount
			restorePoints[].estimatedBytes restorePoints[].sources[].bytes
			scenarios[].preconditionCount scenarioRuntime.active.stepCount
			performance.droppedSampleCount performance.samples[].longFrames
			performance.summary.sampleCount performance.summary.longFrameCount
			componentSummary.sourceTargetCount componentSummary.omittedTargetCount
		`),
	],
	[
		integer(1, Number.MAX_SAFE_INTEGER),
		paths(`
			console[].repeatCount? console[].sourceLocation.line?
			console[].sourceLocation.column?
			scenarios[].version scenarioRuntime.active.scenarioVersion
			scenarioReceipts[].scenarioVersion
		`),
	],
	[
		finite(0, Number.POSITIVE_INFINITY),
		paths(`
			network[].durationMs? routeEvents[].durationMs?
			performance.samples[].memoryMb? performance.samples[].eventLoopLagMs
			performance.samples[].maxFrameMs
			performance.summary.durationMs performance.summary.averageJsFps
			performance.summary.averageUiFps? performance.summary.averageEventLoopLagMs
			performance.summary.p95EventLoopLagMs performance.summary.maxEventLoopLagMs
			components[].bounds.width components[].bounds.height
		`),
	],
	[integer(0, NUMBERS.httpStatus), ['network[].status?']],
	[
		finite(0, NUMBERS.fps),
		paths('performance.samples[].jsFps performance.samples[].uiFps?'),
	],
	[finite(0, NUMBERS.cpuPercent), ['performance.samples[].cpuPercent?']],
	[
		integer(0, NUMBERS.zustandStateBytes),
		['zustandStateSnapshots[].stateBytes'],
	],
	[integer(0, NUMBERS.componentDepth), ['components[].depth?']],
	[
		finite(-NUMBERS.componentZIndex, NUMBERS.componentZIndex),
		['components[].zIndex?'],
	],
	[
		finite(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY),
		paths('components[].bounds.x components[].bounds.y'),
	],
	[
		finite(0, NUMBERS.renderDurationMs),
		paths('componentRenders[].actualDuration componentRenders[].baseDuration'),
	],
	[integer(1, NUMBERS.renderCount), ['componentRenders[].renderCount']],
];

/**
 * The camera fixture's numbers, bounded as well, but the schema also demands
 * that they agree, so a number the fit has to drop or lift takes the whole
 * fixture with it. The grid test at the end covers those.
 */
const CAMERA_NUMBER_FIELDS: readonly (readonly [
	range: Range,
	paths: string[],
])[] = [
	[integer(0, NUMBERS.cameraFixtureBytes), ['cameraFixture.bytes?']],
	[
		integer(1, NUMBERS.cameraFixtureDimension),
		paths('cameraFixture.width? cameraFixture.height?'),
	],
	[integer(1, NUMBERS.cameraFixtureDurationMs), ['cameraFixture.durationMs?']],
];

type ListField = Readonly<{
	path: string;
	limit: number;
	keeps: 'first' | 'newest';
}>;

const TOP_LEVEL_LISTS = [
	'network',
	'console',
	'storage',
	'storageEvents',
	'queries',
	'mutations',
	'routes',
	'routeEvents',
	'environment',
	'zustandStores',
	'zustandChanges',
	'zustandStateSnapshots',
	'zustandMutationReceipts',
	'restorePoints',
	'restoreReceipts',
	'scenarios',
	'scenarioReceipts',
	'components',
	'componentRenders',
	'diagnostics',
] as const satisfies readonly (keyof typeof LIMITS)[];

const first = (path: string, limit: number): ListField => ({
	path,
	limit,
	keeps: 'first',
});
const newest = (path: string, limit: number): ListField => ({
	path,
	limit,
	keeps: 'newest',
});

/** Every list the schema caps. A top-level one keeps its newest rows. */
const LIST_FIELDS: readonly ListField[] = [
	...TOP_LEVEL_LISTS.map((path) => newest(path, LIMITS[path])),
	first('storageEvents[].structuralDiff', EXTRA.storageStructuralDiff),
	first('storageSummary.errors', EXTRA.storageSummaryErrors),
	first('querySimulation.families', EXTRA.querySimulationFamilies),
	first('querySimulation.families[].modes', EXTRA.querySimulationModes),
	// The schema bounds a Zustand store's keys by the storage key limit.
	first('zustandStores[].keys', LIMITS.storageKeys),
	first('zustandChanges[].changedKeys', LIMITS.zustandChangedKeys),
	first('zustandMutationReceipts[].changedKeys', LIMITS.zustandChangedKeys),
	first('restorePoints[].sources', LIMITS.restoreSources),
	first('restoreReceipts[].sourceResults', LIMITS.restoreSources),
	first('scenarios[].variables', LIMITS.scenarioVariables),
	first('scenarios[].variables[].options', EXTRA.scenarioVariableOptions),
	first('scenarios[].steps', LIMITS.scenarioSteps),
	first('scenarioRuntime.active.warnings', EXTRA.scenarioWarnings),
	first('scenarioReceipts[].stepResults', LIMITS.scenarioSteps),
	first('scenarioReceipts[].stepResults[].warnings', EXTRA.scenarioWarnings),
	newest('identitySession.history', LIMITS.identityHistory),
	first('identitySession.personas', LIMITS.identityPersonas),
	newest('performance.samples', LIMITS.performanceSamples),
	first('components[].sourceFiles', LIMITS.componentSourceFiles),
	first('components[].actions', EXTRA.componentActions),
	first('componentRenders[].changedKeys', EXTRA.componentRenderChangedKeys),
	first(
		'componentSummary.registrationDiagnostics',
		LIMITS.componentDiagnostics
	),
	// The schema bounds the instances of one diagnostic by the component limit.
	first(
		'componentSummary.registrationDiagnostics[].instanceIds',
		LIMITS.components
	),
];

type RecordField = Readonly<{
	path: string;
	maxFields: number;
	maxName: number;
	maxValue: number;
}>;

/** Maps from a name to a text, whose fields, names and values are bounded. */
const RECORD_FIELDS: readonly RecordField[] = [
	{
		path: 'network[].requestHeaders',
		maxFields: EXTRA.headerFields,
		maxName: TEXT.headerName,
		maxValue: TEXT.long,
	},
	{
		path: 'network[].responseHeaders',
		maxFields: EXTRA.headerFields,
		maxName: TEXT.headerName,
		maxValue: TEXT.long,
	},
	{
		path: 'components[].accessibilityState',
		maxFields: EXTRA.accessibilityStateFields,
		maxName: TEXT.short,
		maxValue: TEXT.short,
	},
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Json = Record<string | number, unknown>;
type Edit = readonly [path: string, value: unknown];

function segments(path: string): (string | number)[] {
	return path
		.split('.')
		.flatMap((part) => (part.endsWith('[]') ? [part.slice(0, -2), 0] : [part]));
}

function read(root: unknown, path: string): unknown {
	let value = root;
	for (const key of segments(path)) value = (value as Json)[key];
	return value;
}

/** Sets the value at a path of `root`; `undefined` removes the field. */
function assign(root: Json, path: string, value: unknown): void {
	const keys = segments(path);
	const last = keys.pop() as string | number;
	let parent = root;
	for (const key of keys) parent = parent[key] as Json;
	if (value === undefined) delete parent[last];
	else parent[last] = value;
}

/** A copy of the sample with each edit applied. */
function edit(...edits: Edit[]): Tools {
	const copy = structuredClone(SAMPLE) as Json;
	for (const [path, value] of edits) assign(copy, path, value);
	return copy as unknown as Tools;
}

/** Parses a snapshot as the broker does: after it has been through JSON. */
function parseWire(tools: unknown) {
	return deviceSnapshotMessageSchema.safeParse(
		JSON.parse(
			JSON.stringify({
				type: 'snapshot',
				sequence: 1,
				sentAt: 1_700_000_000_000,
				tools,
			})
		)
	);
}
type Parsed = ReturnType<typeof parseWire>;

/** Writes a schema issue's path the way the sample's paths are written. */
function describePath(path: readonly PropertyKey[]): string {
	let text = '';
	for (const segment of path.slice(1)) {
		if (typeof segment === 'number') text += '[]';
		else text += text ? `.${String(segment)}` : String(segment);
	}
	return text;
}

function issuePaths(result: Parsed): Set<string> {
	return new Set(
		result.success
			? []
			: result.error.issues.map((issue) => describePath(issue.path))
	);
}

function explain(result: Parsed): string {
	if (result.success) return 'accepted';
	return `rejected at ${result.error.issues
		.slice(0, 5)
		.map((issue) => `${describePath(issue.path)} (${issue.message})`)
		.join(', ')}`;
}

function expectAccepted(tools: unknown, context: string): void {
	const result = parseWire(tools);
	expect(result.success, `${context}: ${explain(result)}`).toBe(true);
}

/** The edits that give a text a value. The schema wants a family and its active entry to agree, so those two change together. */
const LINKED: Readonly<Record<string, string>> = {
	'querySimulation.active.familyId': 'querySimulation.families[].id',
	'querySimulation.active.familyLabel': 'querySimulation.families[].label',
	'querySimulation.families[].id': 'querySimulation.active.familyId',
	'querySimulation.families[].label': 'querySimulation.active.familyLabel',
};

function textEdits(path: string, value: string): Edit[] {
	const other = LINKED[path];
	return other
		? [
				[path, value],
				[other, value],
			]
		: [[path, value]];
}

const unmarked = (field: string): string => field.replace(/[?!]$/, '');

/** A list's rows: copies of the sample's own, then more, each one told apart. */
function rowsOf(path: string, count: number): unknown[] {
	const existing = read(SAMPLE, path) as unknown[];
	const template = existing[0];
	return Array.from({ length: count }, (_, index) => {
		if (index < existing.length) return structuredClone(existing[index]);
		if (typeof template === 'string') {
			// Only a few values are an action, so those repeat.
			return path === 'components[].actions'
				? template
				: `${template}-${index}`;
		}
		const copy = structuredClone(template) as Json;
		if (path === 'querySimulation.families')
			copy.id = `${String(copy.id)}-${index}`;
		return copy;
	});
}

const isTopLevel = (path: string): boolean => !/[.[]/.test(path);

/** Every object that picks one of the values for each key, leaving out a key picked as `undefined`. */
function combinations(
	options: Record<string, readonly unknown[]>
): Record<string, unknown>[] {
	return Object.entries(options).reduce<Record<string, unknown>[]>(
		(partials, [key, values]) =>
			partials.flatMap((partial) =>
				values.map((value) =>
					value === undefined ? partial : { ...partial, [key]: value }
				)
			),
		[{}]
	);
}

// ---------------------------------------------------------------------------
// The sample
// ---------------------------------------------------------------------------

describe('the sample snapshot', () => {
	it('is valid and needs no fitting', () => {
		expectAccepted(SAMPLE, 'the sample');
		const fitted = fitDesktopSnapshot(SAMPLE);
		expect(fitted.tools).toBe(SAMPLE);
		expect(fitted.trimmed).toEqual([]);
	});

	it('has every field of the contract classified', () => {
		const recordPaths = new Set(RECORD_FIELDS.map(({ path }) => path));
		const leaves: [path: string, value: unknown][] = [];
		const walk = (value: unknown, path: string) => {
			if (Array.isArray(value)) {
				leaves.push([path, value]);
				if (value.length > 0) walk(value[0], `${path}[]`);
			} else if (
				typeof value === 'object' &&
				value !== null &&
				!recordPaths.has(path)
			) {
				for (const [key, child] of Object.entries(value)) {
					walk(child, path ? `${path}.${key}` : key);
				}
			} else {
				leaves.push([path, value]);
			}
		};
		walk(SAMPLE, '');

		const known = new Set([
			...TEXT_FIELDS.flatMap(([, fields]) => fields),
			...ENUM_FIELDS,
			...[...NUMBER_FIELDS, ...CAMERA_NUMBER_FIELDS].flatMap(([, fields]) =>
				fields.map(unmarked)
			),
			...LIST_FIELDS.map(({ path }) => path),
			...recordPaths,
		]);
		const present = new Set(leaves.map(([path]) => path));
		const unclassified = leaves
			.filter(
				([path, value]) =>
					typeof value !== 'boolean' && value !== null && !known.has(path)
			)
			.map(([path]) => path);
		expect(
			unclassified,
			'a field with no bound listed: classify it above, then bound it in fitDesktopSnapshot'
		).toEqual([]);
		expect(
			[...known].filter((path) => !present.has(path)),
			'a path listed above that the sample does not have'
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// One field at a time
// ---------------------------------------------------------------------------

describe('text bounds', () => {
	it.each(TEXT_FIELDS)('cut a text to %i characters', (limit, fields) => {
		for (const path of fields) {
			const atLimit = edit(...textEdits(path, 'x'.repeat(limit)));
			expect(fitDesktopSnapshot(atLimit).tools, `${path} at its limit`).toBe(
				atLimit
			);

			const over = edit(...textEdits(path, 'x'.repeat(limit + 1)));
			expect(issuePaths(parseWire(over)), `${path} over its limit`).toContain(
				path
			);
			const fitted = fitDesktopSnapshot(over);
			expect(read(fitted.tools, path), path).toBe('x'.repeat(limit));
			expect(fitted.trimmed, path).toContain(`${path} to ${limit} characters`);
		}
	});

	it('measures an identifier or a method after trimming it, as the schema does', () => {
		for (const [limit, fields] of TEXT_FIELDS.slice(0, 2)) {
			for (const path of fields) {
				const padded = edit(...textEdits(path, `  ${'x'.repeat(limit)}\n`));
				expectAccepted(padded, `${path} padded to its limit`);
				expect(fitDesktopSnapshot(padded).tools, path).toBe(padded);

				const over = edit(...textEdits(path, `  ${'x'.repeat(limit + 1)}\n`));
				expect(issuePaths(parseWire(over)), path).toContain(path);
				expect(read(fitDesktopSnapshot(over).tools, path), path).toBe(
					'x'.repeat(limit)
				);
			}
		}
	});

	it('cuts by UTF-16 code units, which is never longer than the code points the schema counts', () => {
		const path = 'diagnostics[].scope';
		const limit = TEXT.short;
		// 4,096 code points, so the schema takes them, in twice as many code units.
		const emoji = edit([path, '😀'.repeat(limit)]);
		expectAccepted(emoji, 'the schema counts code points');

		const fitted = fitDesktopSnapshot(emoji);
		const scope = read(fitted.tools, path) as string;
		expect(scope).toHaveLength(limit);
		expect(scope).toBe('😀'.repeat(limit / 2));
		expectAccepted(fitted.tools, 'the cut text');

		// An odd limit would end the cut in the middle of a pair.
		const odd = edit([path, `a${'😀'.repeat(limit)}`]);
		const kept = read(fitDesktopSnapshot(odd).tools, path) as string;
		expect(kept).toBe(`a${'😀'.repeat(limit / 2 - 1)}`);
		expectAccepted(fitDesktopSnapshot(odd).tools, 'the cut text');
	});
});

describe('number bounds', () => {
	type NumberCase = Readonly<{
		name: string;
		bad: number;
		expected: number | null | undefined;
	}>;

	function numberCases(
		{ min, max, integer: whole }: Range,
		kind: 'required' | 'optional' | 'nullable'
	): NumberCase[] {
		const cases: NumberCase[] = [];
		if (Number.isFinite(min)) {
			cases.push({ name: 'below its minimum', bad: min - 1, expected: min });
		}
		if (Number.isFinite(max)) {
			const bad = max === Number.MAX_SAFE_INTEGER ? 2 ** 60 : max + 1;
			cases.push({ name: 'above its maximum', bad, expected: max });
		}
		if (whole) cases.push({ name: 'with a fraction', bad: 5.7, expected: 5 });
		// Not finite goes over the wire as `null`, which only a nullable takes.
		const fallback =
			kind === 'optional'
				? undefined
				: kind === 'nullable'
					? null
					: Number.isFinite(min)
						? min
						: 0;
		for (const bad of [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]) {
			cases.push({ name: `as ${bad}`, bad, expected: fallback });
		}
		return cases;
	}

	function check(
		range: Range,
		field: string,
		keep: (name: string) => boolean
	): void {
		const kind = field.endsWith('?')
			? 'optional'
			: field.endsWith('!')
				? 'nullable'
				: 'required';
		const path = unmarked(field);
		for (const { name, bad, expected } of numberCases(range, kind)) {
			if (!keep(name)) continue;
			const label = `${path} ${name}`;
			const hostile = edit([path, bad]);
			if (kind !== 'nullable' || Number.isFinite(bad)) {
				expect(issuePaths(parseWire(hostile)), label).toContain(path);
			}

			const fitted = fitDesktopSnapshot(hostile);
			expect(read(fitted.tools, path), label).toBe(expected);
			expectAccepted(fitted.tools, label);
			expect(
				fitted.trimmed.some((change) => change.startsWith(`${path} `)),
				`${label} is reported`
			).toBe(true);
		}
	}

	it.each(
		NUMBER_FIELDS.map(
			([range, fields]) =>
				[
					`${range.integer ? 'integers' : 'numbers'} from ${range.min} to ${range.max}`,
					range,
					fields,
				] as const
		)
	)('keep %s inside them', (_name, range, fields) => {
		for (const field of fields) check(range, field, () => true);
	});

	it('keeps a camera fixture number inside its range', () => {
		// Whatever the fit would drop or lift to a bound that disagrees with the
		// rest of the fixture is the grid test's.
		for (const [range, fields] of CAMERA_NUMBER_FIELDS) {
			for (const field of fields) {
				check(
					range,
					field,
					(name) => name === 'above its maximum' || name === 'with a fraction'
				);
			}
		}
	});
});

describe('list limits', () => {
	it.each(LIST_FIELDS)(
		'keep the $keeps rows of $path within $limit',
		({ path, limit, keeps }) => {
			const atLimit = edit([path, rowsOf(path, limit)]);
			expect(fitDesktopSnapshot(atLimit).tools).toBe(atLimit);

			const rows = rowsOf(path, limit + 1);
			const over = edit([path, rows]);
			expect(issuePaths(parseWire(over))).toContain(path);

			const fitted = fitDesktopSnapshot(over);
			// Samples the fit cuts count as dropped, which is what the performance
			// panel reads to say so.
			expect(fitted.trimmed).toEqual([
				`${path} to ${limit} rows`,
				...(path === 'performance.samples'
					? ['performance.droppedSampleCount raised for the samples cut']
					: []),
			]);
			const kept = read(fitted.tools, path) as unknown[];
			expect(kept).toHaveLength(limit);
			expect(kept[0]).toBe(keeps === 'newest' ? rows[1] : rows[0]);
			expect(kept.at(-1)).toBe(
				keeps === 'newest' ? rows[limit] : rows[limit - 1]
			);
			// A top-level list is the heaviest thing to parse, and the snapshot
			// of everything at once below parses all of them.
			if (!isTopLevel(path)) expectAccepted(fitted.tools, path);
		},
		60_000
	);
});

describe('map bounds', () => {
	const fieldsOf = (count: number): Record<string, string> =>
		Object.fromEntries(
			Array.from({ length: count }, (_, index) => [`field-${index}`, 'value'])
		);

	it.each(RECORD_FIELDS)(
		'hold $path to $maxFields fields, names and values',
		({ path, maxFields, maxName, maxValue }) => {
			const atLimit = edit([
				path,
				Object.fromEntries(
					Array.from({ length: maxFields }, (_, index) => [
						String(index).padStart(maxName, 'n'),
						'value',
					])
				),
			]);
			expectAccepted(atLimit, `${path} at its limits`);
			expect(fitDesktopSnapshot(atLimit).tools).toBe(atLimit);

			const crowded = edit([path, fieldsOf(maxFields + 1)]);
			expect(issuePaths(parseWire(crowded)).has(path)).toBe(true);
			const fewer = fitDesktopSnapshot(crowded);
			expect(read(fewer.tools, path)).toEqual(fieldsOf(maxFields));
			expect(fewer.trimmed).toEqual([`${path} to ${maxFields} fields`]);
			expectAccepted(fewer.tools, `${path} crowded`);

			const named = edit([
				path,
				{ first: 'a', ['n'.repeat(maxName + 1)]: 'dropped', last: 'b' },
			]);
			expect(
				[...issuePaths(parseWire(named))].some((issue) =>
					issue.startsWith(path)
				)
			).toBe(true);
			const renamed = fitDesktopSnapshot(named);
			expect(read(renamed.tools, path)).toEqual({ first: 'a', last: 'b' });
			expect(renamed.trimmed).toEqual([
				`${path} names over ${maxName} characters dropped`,
			]);
			expectAccepted(renamed.tools, `${path} with a long name`);

			const valued = edit([path, { first: 'x'.repeat(maxValue + 1) }]);
			expect(
				[...issuePaths(parseWire(valued))].some((issue) =>
					issue.startsWith(path)
				)
			).toBe(true);
			const cut = fitDesktopSnapshot(valued);
			expect(read(cut.tools, path)).toEqual({ first: 'x'.repeat(maxValue) });
			expect(cut.trimmed).toEqual([`${path}[] to ${maxValue} characters`]);
			expectAccepted(cut.tools, `${path} with a long value`);
		},
		60_000
	);
});

// ---------------------------------------------------------------------------
// What a bound can break
// ---------------------------------------------------------------------------

/**
 * The schema accepts the fit's output whatever came in; and when what came in
 * was already accepted, the fit has changed nothing. Returns the fitted tools.
 */
function expectFitted(tools: Tools, context: string) {
	const accepted = parseWire(tools).success;
	const fitted = fitDesktopSnapshot(tools);
	expectAccepted(fitted.tools, `${context} after the fit`);
	if (accepted) {
		expect(fitted.tools, `${context} was valid and is left alone`).toBe(tools);
		expect(fitted.trimmed, context).toEqual([]);
	}
	return { accepted, fitted };
}

describe('what the fit has to keep consistent', () => {
	it('drops the active query simulation when its family is not listed', () => {
		const family = (id: string, supported: boolean) => ({
			id,
			label: id.toUpperCase(),
			modes: [
				{ mode: 'loading', supported },
				{ mode: 'error', supported: false, reason: 'Never' },
				{ mode: 'paused', supported: false, reason: 'Never' },
				{ mode: 'offline', supported: false, reason: 'Never' },
			],
		});
		const active = (familyId: string, familyLabel: string, mode: string) => ({
			familyId,
			familyLabel,
			mode,
			receiptId: 'receipt',
			startedAt: 1,
		});
		const variants = [
			['it names a listed family', active('a', 'A', 'loading'), true],
			['its family is not listed', active('b', 'B', 'loading'), false],
			['its label differs', active('a', 'Other', 'loading'), false],
			['its mode is not supported', active('a', 'A', 'error'), false],
			['its mode is not offered', active('a', 'A', 'nowhere'), false],
		] as const;
		for (const [name, entry, valid] of variants) {
			const tools = edit([
				'querySimulation',
				{ families: [family('a', true)], active: entry },
			]);
			const { accepted, fitted } = expectFitted(tools, name);
			expect(accepted, name).toBe(valid);
			if (!valid) {
				expect(
					read(fitted.tools, 'querySimulation.active'),
					name
				).toBeUndefined();
				expect(fitted.trimmed, name).toEqual([
					'querySimulation.active dropped (it names no supported family mode)',
				]);
			}
		}
	});

	it('drops the active query simulation whose family the cap cut away', () => {
		const rows = rowsOf(
			'querySimulation.families',
			EXTRA.querySimulationFamilies + 1
		);
		const last = rows.at(-1) as { id: string; label: string };
		const tools = edit(
			['querySimulation.families', rows],
			['querySimulation.active.familyId', last.id],
			['querySimulation.active.familyLabel', last.label]
		);
		expect(parseWire(tools).success).toBe(false);
		const fitted = fitDesktopSnapshot(tools);
		expectAccepted(fitted.tools, 'the cut simulation');
		expect(read(fitted.tools, 'querySimulation.active')).toBeUndefined();
		expect(fitted.trimmed).toEqual([
			`querySimulation.families to ${EXTRA.querySimulationFamilies} rows`,
			'querySimulation.active dropped (it names no supported family mode)',
		]);
	});

	it('resets a camera fixture whose metadata disagrees, which is what the schema checks', () => {
		const fixtures = combinations({
			active: [false, true],
			kind: [undefined, 'still', 'qr', 'video', 'unavailable', 'error'],
			label: [undefined, 'Clip'],
			mimeType: [undefined, 'image/png', 'video/mp4', 'video/quicktime'],
			bytes: [undefined, 0, 100],
			width: [undefined, 10],
			height: [undefined, 10],
			durationMs: [undefined, 5],
		});
		expect(fixtures).toHaveLength(2 * 6 * 2 * 4 * 3 * 2 * 2 * 2);

		let reset = 0;
		for (const fixture of fixtures) {
			const tools = edit(['cameraFixture', fixture]);
			const { accepted, fitted } = expectFitted(tools, JSON.stringify(fixture));
			if (accepted) continue;
			reset += 1;
			expect(read(fitted.tools, 'cameraFixture')).toEqual({ active: false });
			expect(fitted.trimmed).toEqual([
				'cameraFixture reset (its metadata is inconsistent)',
			]);
		}
		// Both the metadata the schema takes and the metadata it refuses were tried.
		expect(reset).toBeGreaterThan(0);
		expect(reset).toBeLessThan(fixtures.length);
	}, 30_000);

	it('resets a camera fixture that loses a number to the fit', () => {
		for (const field of ['bytes', 'width', 'height', 'durationMs']) {
			const path = `cameraFixture.${field}`;
			for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
				const { fitted } = expectFitted(edit([path, bad]), `${path} as ${bad}`);
				expect(read(fitted.tools, 'cameraFixture')).toEqual({ active: false });
			}
		}
		// A video of no bytes is no video either.
		const { fitted } = expectFitted(
			edit(['cameraFixture.bytes', -1]),
			'a negative size'
		);
		expect(read(fitted.tools, 'cameraFixture')).toEqual({ active: false });
	});

	it('drops a scenario variable default that is not of its type', () => {
		const defaults = ['a', 1, true, null, Number.NaN, undefined];
		for (const type of ['string', 'number', 'boolean']) {
			for (const defaultValue of defaults) {
				const variable = {
					id: 'variable',
					label: 'Variable',
					type,
					required: false,
					...(defaultValue === undefined ? {} : { defaultValue }),
				};
				const tools = edit(['scenarios[].variables', [variable]]);
				const name = `a ${type} defaulting to ${String(defaultValue)}`;
				const { accepted, fitted } = expectFitted(tools, name);
				if (!accepted) {
					const [fittedVariable] = read(
						fitted.tools,
						'scenarios[].variables'
					) as Json[];
					expect(fittedVariable, name).not.toHaveProperty('defaultValue');
				}
			}
		}
	});

	it('writes an option that is not a finite number as null, as JSON does', () => {
		const tools = edit([
			'scenarios[].variables[].options',
			[1, Number.NaN, Number.POSITIVE_INFINITY, 'two'],
		]);
		const fitted = fitDesktopSnapshot(tools);
		expect(read(fitted.tools, 'scenarios[].variables[].options')).toEqual([
			1,
			null,
			null,
			'two',
		]);
		expect(fitted.trimmed).toEqual([
			'scenarios[].variables[].options[] to null (not a finite number)',
		]);
		expectAccepted(fitted.tools, 'the options');
	});

	it('drops a persona identifier from an identity that is not a persona', () => {
		const identities = [
			{ kind: 'signed-out', label: 'Nobody' },
			{ kind: 'signed-out', label: 'Nobody', personaId: 'persona-1' },
			{ kind: 'account', label: 'Alex', personaId: 'persona-1' },
			{ kind: 'persona', label: 'Alex', personaId: 'persona-1' },
		];
		for (const identity of identities) {
			const tools = edit(['identitySession.active.actor', identity]);
			const name = JSON.stringify(identity);
			const { accepted, fitted } = expectFitted(tools, name);
			if (!accepted) {
				expect(
					read(fitted.tools, 'identitySession.active.actor'),
					name
				).toEqual({
					kind: identity.kind,
					label: identity.label,
				});
			}
		}
	});

	it('leaves a persona with no identifier to the schema', () => {
		const tools = edit([
			'identitySession.active.actor',
			{ kind: 'persona', label: 'Alex' },
		]);
		expect(parseWire(tools).success).toBe(false);
		const fitted = fitDesktopSnapshot(tools);
		expect(fitted.tools).toBe(tools);
		expect(parseWire(fitted.tools).success).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Everything at once
// ---------------------------------------------------------------------------

describe('a snapshot over every bound at once', () => {
	/** The most a number can be and still be accepted, or the least, as a number with no bounds is. */
	function extreme(range: Range, side: 'max' | 'min'): number {
		if (side === 'max') {
			return Number.isFinite(range.max) ? range.max : 1e300;
		}
		return Number.isFinite(range.min) ? range.min : -1e300;
	}

	function numberFields() {
		return [...NUMBER_FIELDS, ...CAMERA_NUMBER_FIELDS].flatMap(
			([range, fields]) =>
				fields.map((field) => [range, unmarked(field)] as const)
		);
	}

	function boundaryTools(side: 'max' | 'min'): Tools {
		const edits: Edit[] = [];
		if (side === 'max') {
			for (const { path, limit } of LIST_FIELDS.filter(
				(f) => !isTopLevel(f.path)
			)) {
				edits.push([path, rowsOf(path, limit)]);
			}
		}
		for (const [range, path] of numberFields()) {
			// A fixture of no bytes is no fixture.
			if (side === 'min' && path.startsWith('cameraFixture.')) continue;
			edits.push([path, extreme(range, side)]);
		}
		if (side === 'max') {
			for (const [limit, fields] of TEXT_FIELDS) {
				for (const path of fields)
					edits.push(...textEdits(path, 'x'.repeat(limit)));
			}
		}
		const tools = edit(...edits) as unknown as Json;
		if (side === 'max') {
			// The row the edits went into stays first, and pristine ones fill up.
			for (const { path, limit } of LIST_FIELDS.filter((f) =>
				isTopLevel(f.path)
			)) {
				const rows = rowsOf(path, limit);
				rows[0] = (tools[path] as unknown[])[0];
				tools[path] = rows;
			}
		}
		return tools as unknown as Tools;
	}

	function hostileTools(): Tools {
		// Lists inside a row first, parents before their children, then the
		// texts and numbers of each row, then the top-level lists, with the row
		// that carries all of it last, where a list keeps its newest rows.
		const nested = LIST_FIELDS.filter((f) => !isTopLevel(f.path)).sort(
			(a, b) => a.path.length - b.path.length
		);
		const edits: Edit[] = nested.map(
			({ path, limit }) => [path, rowsOf(path, limit + 1)] as const
		);
		for (const [limit, fields] of TEXT_FIELDS) {
			for (const path of fields)
				edits.push(...textEdits(path, 'x'.repeat(limit + 1)));
		}
		for (const [range, path] of numberFields()) {
			const { min, max } = range;
			const above = max === Number.MAX_SAFE_INTEGER ? 2 ** 60 : max + 1;
			edits.push([
				path,
				Number.isFinite(max)
					? above
					: Number.isFinite(min)
						? min - 1
						: Number.NaN,
			]);
		}
		for (const { path, maxFields, maxName, maxValue } of RECORD_FIELDS) {
			edits.push([
				path,
				{
					...Object.fromEntries(
						Array.from({ length: maxFields }, (_, index) => [
							`field-${index}`,
							'value',
						])
					),
					['n'.repeat(maxName + 1)]: 'dropped',
					first: 'x'.repeat(maxValue + 1),
				},
			]);
		}
		const tools = edit(...edits) as unknown as Json;
		for (const { path } of nested.filter((f) => f.keeps === 'newest')) {
			const [hostile, ...rest] = read(tools, path) as unknown[];
			assign(tools, path, [...rest, hostile]);
		}
		for (const { path, limit } of LIST_FIELDS.filter((f) =>
			isTopLevel(f.path)
		)) {
			const hostile = (tools[path] as unknown[])[0];
			const pristine = (read(SAMPLE, path) as unknown[])[0];
			tools[path] = [...Array.from({ length: limit }, () => pristine), hostile];
		}
		return tools as unknown as Tools;
	}

	it('takes a snapshot at every bound whole', () => {
		for (const side of ['max', 'min'] as const) {
			const tools = boundaryTools(side);
			expectAccepted(tools, `every bound at its ${side}`);
			expect(fitDesktopSnapshot(tools).tools, side).toBe(tools);
		}
	}, 120_000);

	it('is rejected as it stands and accepted once fitted', () => {
		const tools = hostileTools();
		const raw = parseWire(tools);
		expect(raw.success, 'the snapshot over every bound').toBe(false);

		// Each bound the manifest lists must be one the snapshot breaks, or this
		// test would pass whatever the fit did about it.
		const rejected = issuePaths(raw);
		const listed = [
			...TEXT_FIELDS.flatMap(([, fields]) => fields),
			...numberFields().map(([, path]) => path),
			...LIST_FIELDS.map(({ path }) => path),
		];
		expect(
			listed.filter((path) => !rejected.has(path)),
			`the schema rejects ${rejected.size} paths, but not these`
		).toEqual([]);
		for (const { path } of RECORD_FIELDS) {
			expect(
				[...rejected].some((issue) => issue.startsWith(path)),
				path
			).toBe(true);
		}

		const fitted = fitDesktopSnapshot(tools);
		expectAccepted(fitted.tools, 'the fitted snapshot');

		// And each one is reported.
		const unreported = [
			...listed,
			...RECORD_FIELDS.map(({ path }) => path),
		].filter(
			(path) =>
				!fitted.trimmed.some(
					(change) =>
						change.startsWith(`${path} `) || change.startsWith(`${path}[] `)
				)
		);
		expect(unreported, 'bounds the fit applied without saying so').toEqual([]);

		const again = fitDesktopSnapshot(fitted.tools);
		expect(again.tools).toBe(fitted.tools);
		expect(again.trimmed).toEqual([]);
	}, 240_000);
});
