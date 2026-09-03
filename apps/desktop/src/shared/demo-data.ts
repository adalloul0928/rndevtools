import {
	createEmptyDeviceTools,
	type DesktopAction,
	type DeviceSession,
	type DeviceTools,
	type PerformanceReview,
	type PerformanceSample,
} from './protocol';

const DEMO_DEVICE_ID = 'pumpd-demo-ios';

function samplePerformance(now: number): PerformanceReview {
	const samples: PerformanceSample[] = Array.from({ length: 36 }, (_, index) => {
		const dip = index === 13 || index === 14 || index === 27;
		const lag = dip ? 38 + (index % 3) * 12 : 3 + ((index * 7) % 8);
		return {
			id: `perf-${index}`,
			at: now - (35 - index) * 1_000,
			jsFps: dip ? 42 + (index % 5) : 57 + (index % 4),
			uiFps: dip ? 49 + (index % 4) : 59 + (index % 2),
			cpuPercent: dip ? 43 + (index % 7) : 16 + ((index * 3) % 13),
			memoryMb: 186 + index * 0.35,
			eventLoopLagMs: lag,
			longFrames: dip ? 2 : index % 12 === 0 ? 1 : 0,
			maxFrameMs: dip ? 66 + index : 17 + (index % 8),
			route: index < 18 ? '/(tabs)' : '/workout/active',
		};
	});

	return {
		isActive: true,
		startedAt: now - 36_000,
		stoppedAt: null,
		droppedSampleCount: 0,
		samples,
		summary: summarizePerformance(samples, now - 36_000, now),
	};
}

function percentile(values: number[], fraction: number): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function summarizePerformance(
	samples: PerformanceSample[],
	startedAt: number | null,
	endedAt: number
): PerformanceReview['summary'] {
	const jsFps = samples.map((sample) => sample.jsFps);
	const uiFps = samples.flatMap((sample) =>
		sample.uiFps === undefined ? [] : [sample.uiFps]
	);
	const lags = samples.map((sample) => sample.eventLoopLagMs);
	const average = (values: number[]) =>
		values.length === 0
			? 0
			: values.reduce((total, value) => total + value, 0) / values.length;
	const averageLag = average(lags);
	const p95 = percentile(lags, 0.95);
	const grade = p95 > 80 ? 'critical' : p95 > 32 ? 'needsAttention' : 'healthy';

	return {
		grade: samples.length === 0 ? 'idle' : grade,
		durationMs: startedAt === null ? 0 : Math.max(0, endedAt - startedAt),
		sampleCount: samples.length,
		averageJsFps: average(jsFps),
		averageUiFps: uiFps.length > 0 ? average(uiFps) : undefined,
		averageEventLoopLagMs: averageLag,
		p95EventLoopLagMs: p95,
		maxEventLoopLagMs: Math.max(0, ...lags),
		longFrameCount: samples.reduce((total, sample) => total + sample.longFrames, 0),
	};
}

function demoTools(now: number): DeviceTools {
	return {
		...createEmptyDeviceTools(),
		network: [
			{
				id: 'net-6',
				at: now - 2_300,
				method: 'POST',
				url: 'https://api.pumpd.fit/functions/v1/coach-message',
				host: 'api.pumpd.fit',
				path: '/functions/v1/coach-message',
				status: 200,
				state: 'success',
				durationMs: 742,
				requestBytes: 628,
				responseBytes: 4_896,
				contentType: 'application/json',
				source: 'edge function',
				requestHeaders: {
					'content-type': 'application/json',
					authorization: 'Bearer [REDACTED]',
				},
				requestBody: JSON.stringify(
					{ threadId: '[REDACTED_ID]', message: '[REDACTED]' },
					null,
					2
				),
				responseBody: JSON.stringify(
					{
						response: 'Adjusted your next upper session around recovery.',
						toolCalls: ['get_training_context', 'update_plan'],
					},
					null,
					2
				),
			},
			{
				id: 'net-5',
				at: now - 6_700,
				method: 'GET',
				url: 'https://api.pumpd.fit/rest/v1/workout_sessions?limit=20',
				host: 'api.pumpd.fit',
				path: '/rest/v1/workout_sessions',
				status: 200,
				state: 'success',
				durationMs: 186,
				responseBytes: 18_420,
				contentType: 'application/json',
				source: 'rest',
				responseBody: '[{"id":"[REDACTED_ID]","status":"complete"}]',
			},
			{
				id: 'net-4',
				at: now - 12_900,
				method: 'PATCH',
				url: 'https://api.pumpd.fit/rest/v1/workout_sets?id=eq.[REDACTED_ID]',
				host: 'api.pumpd.fit',
				path: '/rest/v1/workout_sets',
				status: 204,
				state: 'success',
				durationMs: 129,
				requestBytes: 86,
				responseBytes: 0,
				contentType: 'application/json',
				source: 'rest',
				requestBody: '{"reps":8,"weight_kg":102.5,"rpe":8}',
			},
			{
				id: 'net-3',
				at: now - 18_400,
				method: 'GET',
				url: 'https://api.pumpd.fit/rest/v1/training_plans?active=eq.true',
				host: 'api.pumpd.fit',
				path: '/rest/v1/training_plans',
				status: 503,
				state: 'error',
				durationMs: 1_842,
				responseBytes: 142,
				contentType: 'application/json',
				source: 'rest',
				error: 'Upstream connection timed out',
				responseBody: '{"code":"UPSTREAM_TIMEOUT","retryable":true}',
			},
			{
				id: 'net-2',
				at: now - 24_100,
				method: 'POST',
				url: 'https://api.pumpd.fit/rest/v1/device_tokens',
				host: 'api.pumpd.fit',
				path: '/rest/v1/device_tokens',
				status: 201,
				state: 'success',
				durationMs: 211,
				requestBytes: 160,
				responseBytes: 74,
				contentType: 'application/json',
				source: 'rest',
			},
		],
		console: [
			{
				id: 'log-7',
				at: now - 1_900,
				level: 'info',
				message: 'Coach response completed',
				attributesText: '{\n  "duration_ms": 742,\n  "tools": 2\n}',
				source: 'ai-coach',
			},
			{
				id: 'log-6',
				at: now - 4_800,
				level: 'debug',
				message: 'Query cache updated',
				attributesText: '{\n  "query": "workout-sessions",\n  "rows": 20\n}',
				source: 'query',
			},
			{
				id: 'log-5',
				at: now - 12_300,
				level: 'info',
				message: 'Workout set saved',
				attributesText: '{\n  "reps": 8,\n  "weight_kg": 102.5\n}',
				source: 'active-session',
			},
			{
				id: 'log-4',
				at: now - 18_100,
				level: 'error',
				message: 'Training plan request failed',
				attributesText: '{\n  "status": 503,\n  "retryable": true\n}',
				source: 'network',
			},
			{
				id: 'log-3',
				at: now - 31_000,
				level: 'warn',
				message: 'JS frame exceeded interaction budget',
				attributesText: '{\n  "frame_ms": 67,\n  "route": "/workout/active"\n}',
				source: 'performance',
			},
		],
		storage: [
			{
				id: 'storage-theme',
				adapterId: 'pumpd-standard-mmkv',
				adapterTitle: 'Standard MMKV',
				key: 'appearance/theme',
				valueText: 'dark',
				valueType: 'string',
				bytes: 4,
				editable: true,
				sensitive: false,
				updatedAt: now - 86_400_000,
			},
			{
				id: 'storage-devtools',
				adapterId: 'pumpd-standard-mmkv',
				adapterTitle: 'Standard MMKV',
				key: '@pumpd/internal-tools/runtime-state',
				valueText:
					'{"dataSourceMode":"real","showDebugBadges":true,"customFlags":{"newStats":true}}',
				valueType: 'string',
				bytes: 91,
				editable: true,
				sensitive: false,
				updatedAt: now - 42_000,
			},
			{
				id: 'storage-unit',
				adapterId: 'pumpd-standard-mmkv',
				adapterTitle: 'Standard MMKV',
				key: 'preferences/weight-unit',
				valueText: 'kg',
				valueType: 'string',
				bytes: 2,
				editable: true,
				sensitive: false,
				updatedAt: now - 5_400_000,
			},
			{
				id: 'storage-auth',
				adapterId: 'pumpd-secure-mmkv',
				adapterTitle: 'Secure MMKV',
				key: 'supabase.auth.token',
				valueType: 'hidden',
				bytes: 0,
				editable: false,
				sensitive: true,
				updatedAt: now - 3_600_000,
			},
		],
		storageEvents: [
			{
				id: 'storage-event-2',
				at: now - 42_000,
				adapterId: 'pumpd-standard-mmkv',
				key: '@pumpd/internal-tools/runtime-state',
				kind: 'updated',
				previousText: '{"showDebugBadges":false}',
				nextText: '{"showDebugBadges":true}',
			},
		],
		storageSummary: {
			adapterCount: 2,
			totalKeyCount: 4,
			omittedKeyCount: 0,
			truncated: false,
			errors: [],
		},
		queries: [
			{
				id: 'query-profile',
				hash: 'query-1',
				keyText: '["profile", "current"]',
				status: 'success',
				fetchStatus: 'idle',
				updatedAt: now - 52_000,
				observers: 4,
				isStale: false,
				dataText: '{"displayName":"[REDACTED]","trainingAge":4}',
				truncated: false,
			},
			{
				id: 'query-active-workout',
				hash: 'query-2',
				keyText: '["workout", "active"]',
				status: 'success',
				fetchStatus: 'fetching',
				updatedAt: now - 9_000,
				observers: 2,
				isStale: true,
				dataText: '{"exerciseCount":6,"completedSets":11,"totalSets":24}',
				truncated: false,
			},
			{
				id: 'query-training-plan',
				hash: 'query-3',
				keyText: '["training-plan", "active"]',
				status: 'error',
				fetchStatus: 'idle',
				updatedAt: now - 18_000,
				observers: 1,
				isStale: true,
				errorText: 'Upstream connection timed out',
				truncated: false,
			},
			{
				id: 'query-exercises',
				hash: 'query-4',
				keyText: '["exercises", "catalog"]',
				status: 'success',
				fetchStatus: 'idle',
				updatedAt: now - 820_000,
				observers: 0,
				isStale: false,
				dataText: '{"count":1248,"source":"catalog"}',
				truncated: false,
			},
		],
		mutations: [
			{
				id: 'mutation-set',
				keyText: '["workout-set", "save"]',
				status: 'success',
				submittedAt: now - 12_900,
				variablesText: '{"reps":8,"weightKg":102.5}',
				truncated: false,
			},
		],
		querySummary: {
			sourceQueryCount: 4,
			omittedQueryCount: 0,
			sourceMutationCount: 1,
			omittedMutationCount: 0,
			truncated: false,
		},
		routes: [
			{
				id: 'route-tabs',
				path: '/(tabs)',
				name: 'Home',
				kind: 'group',
				filename: 'app/(tabs)/index.tsx',
				isCurrent: false,
				isVisible: false,
				depth: 0,
			},
			{
				id: 'route-workout',
				path: '/workout/active',
				name: 'Active workout',
				kind: 'static',
				filename: 'app/workout/active.tsx',
				isCurrent: true,
				isVisible: true,
				depth: 1,
			},
			{
				id: 'route-exercise',
				path: '/exercises/[exerciseId]',
				name: 'Exercise detail',
				kind: 'dynamic',
				filename: 'app/exercises/[exerciseId].tsx',
				isCurrent: false,
				isVisible: false,
				depth: 0,
			},
			{
				id: 'route-settings',
				path: '/settings',
				name: 'Settings',
				kind: 'static',
				filename: 'app/settings.tsx',
				isCurrent: false,
				isVisible: false,
				depth: 0,
			},
		],
		routeEvents: [
			{
				id: 'route-event-3',
				at: now - 35_000,
				route: '/workout/active',
				metadataText: '{"source":"quick-start"}',
			},
			{
				id: 'route-event-2',
				at: now - 81_000,
				route: '/(tabs)',
			},
		],
		environment: [
			{
				id: 'env-variant',
				section: 'Application',
				key: 'APP_VARIANT',
				valueText: 'development',
				status: 'valid',
			},
			{
				id: 'env-id',
				section: 'Application',
				key: 'APPLICATION_ID',
				valueText: 'com.avadworkout.pumpdmobileapp.development',
				status: 'valid',
			},
			{
				id: 'env-version',
				section: 'Application',
				key: 'APP_VERSION',
				valueText: '1.0.1 (482)',
				status: 'valid',
			},
			{
				id: 'env-update',
				section: 'Updates',
				key: 'UPDATE_CHANNEL',
				valueText: 'development',
				status: 'valid',
			},
			{
				id: 'env-runtime',
				section: 'Updates',
				key: 'RUNTIME_VERSION',
				valueText: '1.0.1',
				status: 'valid',
			},
			{
				id: 'env-platform',
				section: 'Device',
				key: 'PLATFORM',
				valueText: 'ios',
				status: 'valid',
			},
			{
				id: 'env-backend',
				section: 'Backend',
				key: 'DATABASE_CONNECTION',
				valueText: 'LOCAL',
				status: 'valid',
			},
			{
				id: 'env-sentry',
				section: 'Observability',
				key: 'SENTRY_DSN',
				valueText: 'Not set',
				status: 'missing',
				description: 'Optional in local development.',
			},
		],
		zustandStores: [
			{
				id: 'active-session',
				title: 'Active session',
				description: 'Privacy-safe active workout projection',
				stateText:
					'{\n  "status": "active",\n  "exerciseCount": 6,\n  "completedSets": 11,\n  "pendingSetCount": 13,\n  "elapsedSeconds": 1842\n}',
				keys: [
					'status',
					'exerciseCount',
					'completedSets',
					'pendingSetCount',
					'elapsedSeconds',
				],
				updatedAt: now - 2_500,
			},
			{
				id: 'rest-timer',
				title: 'Rest timer',
				description: 'Timer state without notification identifiers',
				stateText:
					'{\n  "status": "running",\n  "durationSeconds": 120,\n  "remainingSeconds": 48,\n  "isVisible": true\n}',
				keys: ['status', 'durationSeconds', 'remainingSeconds', 'isVisible'],
				updatedAt: now - 1_000,
			},
			{
				id: 'dev-menu',
				title: 'Developer overrides',
				description: 'Explicit, restorable diagnostic settings',
				stateText:
					'{\n  "dataSourceMode": "real",\n  "globalStateOverride": "none",\n  "showDebugBadges": true,\n  "customFlags": { "newStats": true }\n}',
				keys: [
					'dataSourceMode',
					'globalStateOverride',
					'showDebugBadges',
					'customFlags',
				],
				updatedAt: now - 42_000,
			},
		],
		zustandChanges: [
			{
				id: 'zustand-change-3',
				at: now - 1_000,
				storeId: 'rest-timer',
				storeTitle: 'Rest timer',
				changedKeys: ['remainingSeconds'],
				stateText: '{"remainingSeconds":48}',
			},
			{
				id: 'zustand-change-2',
				at: now - 2_500,
				storeId: 'active-session',
				storeTitle: 'Active session',
				changedKeys: ['completedSets', 'pendingSetCount'],
				stateText: '{"completedSets":11,"pendingSetCount":13}',
			},
		],
		zustandSummary: {
			totalStoreCount: 3,
			omittedStoreCount: 0,
			truncated: false,
		},
		restorePoints: [
			{
				id: 'restore-before-empty-state',
				label: 'Before empty-state QA',
				createdAt: now - 420_000,
				estimatedBytes: 382,
				sources: [
					{
						id: 'developer-overrides',
						title: 'Developer overrides',
						preview:
							'{"dataSourceMode":"real","globalStateOverride":"none","showDebugBadges":true}',
						bytes: 382,
					},
				],
			},
		],
		performance: samplePerformance(now),
		components: [
			{
				id: 'feedback-active-session',
				name: 'ActiveSessionScreen',
				kind: 'screen',
				feature: 'active-session',
				route: '/workout/active',
				testID: 'active-session-screen',
				targetKey: 'active-session',
				sourceFiles: [
					'apps/mobile/src/features/active-session/screens/active-session-screen.tsx',
				],
				instanceText:
					'{\n  "exerciseCount": 6,\n  "completedSets": 11,\n  "isResting": true\n}',
				instanceTruncated: false,
				bounds: { x: 0, y: 94, width: 393, height: 758 },
				isFocused: true,
			},
			{
				id: 'feedback-set-row',
				name: 'WorkoutSetRow',
				kind: 'component',
				feature: 'active-session',
				route: '/workout/active',
				testID: 'workout-set-row-11',
				targetKey: 'set-row',
				sourceFiles: [
					'apps/mobile/src/features/active-session/components/workout-set-row.tsx',
				],
				instanceText:
					'{\n  "setNumber": 3,\n  "reps": 8,\n  "weightKg": 102.5,\n  "status": "complete"\n}',
				instanceTruncated: false,
				bounds: { x: 16, y: 438, width: 361, height: 64 },
				isFocused: true,
			},
			{
				id: 'feedback-rest-timer',
				name: 'RestTimerOverlay',
				kind: 'overlay',
				feature: 'active-session',
				route: '/workout/active',
				testID: 'rest-timer-overlay',
				targetKey: 'rest-timer',
				sourceFiles: [
					'apps/mobile/src/features/active-session/components/rest-timer-overlay.tsx',
				],
				instanceText: '{\n  "remainingSeconds": 48,\n  "durationSeconds": 120\n}',
				instanceTruncated: false,
				bounds: { x: 16, y: 726, width: 361, height: 92 },
				isFocused: true,
			},
		],
		componentSummary: {
			sourceTargetCount: 3,
			omittedTargetCount: 0,
			truncated: false,
		},
		diagnostics: [
			{
				id: 'diag-ready',
				at: now - 74_000,
				level: 'info',
				scope: 'device',
				message: 'PUMPD demo session registered with protocol v1.',
			},
			{
				id: 'diag-redaction',
				at: now - 70_000,
				level: 'info',
				scope: 'privacy',
				message: 'Console and network payload redaction enabled.',
			},
		],
	};
}

export function createDemoDevice(now = Date.now()): DeviceSession {
	return {
		info: {
			id: DEMO_DEVICE_ID,
			name: 'iPhone 16 Pro · Demo',
			platform: 'simulator',
			model: 'iPhone 16 Pro',
			osVersion: 'iOS 19.6',
			appVersion: '1.0.1',
			buildVersion: '482',
			runtimeVersion: '1.0.1',
			variant: 'development',
			viewport: { width: 393, height: 852 },
			capabilities: [
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
			],
		},
		status: 'simulated',
		connectedAt: now - 84_000,
		lastSeenAt: now,
		sequence: 42,
		latencyMs: 0,
		tools: demoTools(now),
	};
}

function payloadString(action: DesktopAction, key: string): string | undefined {
	const value = action.payload[key];
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function applyDemoAction(
	device: DeviceSession,
	action: DesktopAction,
	now = Date.now()
): DeviceSession {
	const next = structuredClone(device);
	next.lastSeenAt = now;
	next.sequence += 1;

	if (action.tool === 'network' && action.command === 'clear') {
		next.tools.network = [];
		return next;
	}
	if (action.tool === 'console' && action.command === 'clear') {
		next.tools.console = [];
		return next;
	}
	if (action.tool === 'storage' && action.command === 'set') {
		const id = payloadString(action, 'id');
		const valueText = payloadString(action, 'valueText');
		if (!id || valueText === undefined) throw new Error('Storage value is invalid.');
		const entry = next.tools.storage.find((candidate) => candidate.id === id);
		if (!entry?.editable || entry.sensitive) {
			throw new Error('This storage entry cannot be edited.');
		}
		const previousText = entry.valueText;
		entry.valueText = valueText;
		entry.bytes = new TextEncoder().encode(valueText).byteLength;
		entry.updatedAt = now;
		next.tools.storageEvents.unshift({
			id: `storage-event-${now}`,
			at: now,
			adapterId: entry.adapterId,
			key: entry.key,
			kind: 'updated',
			previousText,
			nextText: valueText,
		});
		return next;
	}
	if (action.tool === 'query' && ['invalidate', 'refetch'].includes(action.command)) {
		const id = payloadString(action, 'id');
		const query = next.tools.queries.find((candidate) => candidate.id === id);
		if (!query) throw new Error('Query was not found.');
		if (action.command === 'invalidate') {
			query.isStale = true;
		} else {
			query.fetchStatus = 'fetching';
			query.status = 'success';
			query.errorText = undefined;
			query.updatedAt = now;
		}
		return next;
	}
	if (action.tool === 'routes' && action.command === 'navigate') {
		const path = payloadString(action, 'path');
		if (!path) throw new Error('Route path is required.');
		for (const route of next.tools.routes) {
			route.isCurrent = route.path === path;
			route.isVisible = route.path === path;
		}
		next.tools.routeEvents.unshift({
			id: `route-event-${now}`,
			at: now,
			route: path,
			metadataText: '{"source":"desktop"}',
		});
		return next;
	}
	if (action.tool === 'restore' && action.command === 'capture') {
		const label = payloadString(action, 'label') ?? 'Desktop checkpoint';
		const preview =
			next.tools.zustandStores.find((store) => store.id === 'dev-menu')?.stateText ??
			'{}';
		next.tools.restorePoints.unshift({
			id: `restore-${now}`,
			label,
			createdAt: now,
			estimatedBytes: new TextEncoder().encode(preview).byteLength,
			sources: [
				{
					id: 'developer-overrides',
					title: 'Developer overrides',
					preview,
					bytes: new TextEncoder().encode(preview).byteLength,
				},
			],
		});
		return next;
	}
	if (action.tool === 'restore' && action.command === 'remove') {
		const id = payloadString(action, 'id');
		next.tools.restorePoints = next.tools.restorePoints.filter(
			(point) => point.id !== id
		);
		return next;
	}
	if (action.tool === 'restore' && action.command === 'restore') {
		const id = payloadString(action, 'id');
		if (!next.tools.restorePoints.some((point) => point.id === id)) {
			throw new Error('Restore point was not found.');
		}
		next.tools.diagnostics.unshift({
			id: `diag-restore-${now}`,
			at: now,
			level: 'info',
			scope: 'restore',
			message: `Restored explicit developer state from ${id}.`,
		});
		return next;
	}
	if (action.tool === 'performance' && action.command === 'start') {
		next.tools.performance = {
			isActive: true,
			startedAt: now,
			stoppedAt: null,
			droppedSampleCount: 0,
			samples: [],
			summary: summarizePerformance([], now, now),
		};
		return next;
	}
	if (action.tool === 'performance' && action.command === 'stop') {
		next.tools.performance.isActive = false;
		next.tools.performance.stoppedAt = now;
		next.tools.performance.summary = summarizePerformance(
			next.tools.performance.samples,
			next.tools.performance.startedAt,
			now
		);
		return next;
	}
	if (action.tool === 'components' && action.command === 'refresh') {
		next.tools.diagnostics.unshift({
			id: `diag-components-${now}`,
			at: now,
			level: 'debug',
			scope: 'components',
			message: `Refreshed ${next.tools.components.length} explicit component targets.`,
		});
		return next;
	}
	if (action.tool === 'components' && action.command === 'highlight') {
		const id = payloadString(action, 'id');
		const target = next.tools.components.find((candidate) => candidate.id === id);
		if (!target?.isFocused) {
			throw new Error('Component target is not currently visible.');
		}
		next.tools.diagnostics.unshift({
			id: `diag-components-highlight-${now}`,
			at: now,
			level: 'info',
			scope: 'components',
			message: `Highlighted ${target.name} on the simulated device.`,
		});
		return next;
	}
	if (action.tool === 'zustand' && action.command === 'refresh') {
		next.tools.diagnostics.unshift({
			id: `diag-zustand-${now}`,
			at: now,
			level: 'debug',
			scope: 'zustand',
			message: `Refreshed ${next.tools.zustandStores.length} explicit Zustand projections.`,
		});
		for (const store of next.tools.zustandStores) store.updatedAt = now;
		return next;
	}

	throw new Error(`Unsupported demo action: ${action.tool}.${action.command}`);
}

export function tickDemoDevice(device: DeviceSession, now = Date.now()): DeviceSession {
	const next = structuredClone(device);
	next.lastSeenAt = now;
	next.sequence += 1;
	const review = next.tools.performance;
	if (review.isActive) {
		const index = review.samples.length;
		const lag = index % 19 === 0 ? 41 : 3 + ((index * 5) % 9);
		review.samples.push({
			id: `perf-live-${now}`,
			at: now,
			jsFps: lag > 30 ? 45 : 58 + (index % 3),
			uiFps: lag > 30 ? 52 : 60,
			cpuPercent: lag > 30 ? 44 : 18 + (index % 10),
			memoryMb: 198 + index * 0.08,
			eventLoopLagMs: lag,
			longFrames: lag > 30 ? 2 : 0,
			maxFrameMs: lag > 30 ? 58 : 18 + (index % 5),
			route: next.tools.routes.find((route) => route.isCurrent)?.path ?? '/(tabs)',
		});
		const omitted = Math.max(0, review.samples.length - 1_500);
		review.samples = review.samples.slice(-1_500);
		review.droppedSampleCount += omitted;
		review.summary = summarizePerformance(review.samples, review.startedAt, now);
	}
	return next;
}
