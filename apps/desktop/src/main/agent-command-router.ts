import { randomUUID } from 'node:crypto';
import {
	type AgentCliTarget,
	isSafeAgentConnectedAction,
} from '../shared/agent-cli-protocol';
import type {
	DesktopAction,
	DesktopActionResult,
	DesktopState,
	DeviceSession,
} from '../shared/protocol';
import { desktopActionSchema } from '../shared/protocol';
import type {
	SimulatorAction,
	SimulatorActionReceipt,
	SimulatorCapture,
	SimulatorJob,
	SimulatorState,
} from '../shared/simulator-protocol';
import type {
	SlimmingAction,
	SlimmingActionReceipt,
	SlimmingJob,
	SlimmingState,
} from '../shared/slimming-protocol';
import { AgentCliError, type AgentCliHandler } from './agent-cli-service';

const TERMINAL_JOB_STATUSES = new Set([
	'complete',
	'failed',
	'needs-attention',
	'cancelled',
]);
const CONNECTED_WAIT_SLICE_MS = 5_000;
const ALL_DOCTOR_CAPABILITIES = [
	'push-notifications',
	'storekit',
	'universal-links',
	'icloud-sync',
	'healthkit',
	'homekit',
	'photo-library',
	'contacts',
	'calendar',
	'siri',
	'spotlight',
	'app-store',
] as const;

type BrokerPort = {
	getState: () => DesktopState;
	dispatchAction: (action: DesktopAction) => Promise<DesktopActionResult>;
};

type SimulatorPort = {
	getState: () => SimulatorState;
	refresh: () => Promise<SimulatorState>;
	runAction: (action: SimulatorAction) => SimulatorActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SimulatorState) => void) => () => void;
};

type SlimmingPort = {
	getState: () => SlimmingState;
	refresh: () => Promise<SlimmingState>;
	runAction: (action: SlimmingAction) => SlimmingActionReceipt;
	cancelJob: (jobId: string) => boolean;
	subscribe: (listener: (state: SlimmingState) => void) => () => void;
};

type AgentRecipePort = {
	list: () => Promise<unknown> | unknown;
	get: (recipeId: string) => Promise<unknown> | unknown;
	run: (recipeId: string, udids: readonly string[]) => Promise<unknown>;
	cancel: (runId: string) => Promise<unknown> | unknown;
	status: (runId?: string) => Promise<unknown> | unknown;
};

export type AgentCommandRouterDependencies = {
	broker: BrokerPort;
	simulator: SimulatorPort;
	slimming: SlimmingPort;
	recipes?: AgentRecipePort;
};

function unavailable(message: string, recovery?: string): never {
	throw new AgentCliError({
		code: 'unavailable',
		message,
		retryable: false,
		...(recovery ? { recovery } : {}),
	});
}

function required(message: string): never {
	throw new AgentCliError({
		code: 'invalid_command',
		message,
		retryable: false,
	});
}

function connectedDeviceForTarget(
	state: DesktopState,
	target: AgentCliTarget
): DeviceSession {
	const matches =
		'deviceId' in target
			? state.devices.filter((device) => device.info.id === target.deviceId)
			: state.devices.filter(
					(device) =>
						device.info.simulatorUdid?.toLowerCase() ===
						target.udid.toLowerCase()
				);
	const online = matches.filter((device) => device.status !== 'offline');
	if (online.length === 1) return online[0] as DeviceSession;
	if (online.length > 1) {
		throw new AgentCliError({
			code: 'ambiguous_target',
			message: 'More than one connected PUMPD session matches this Simulator.',
			recovery: 'Retry with the exact connected deviceId.',
		});
	}
	if (matches.length > 0) {
		throw new AgentCliError({
			code: 'device_offline',
			message: 'The matching PUMPD session is offline.',
			retryable: true,
			recovery: 'Launch the development app in the Simulator and retry.',
		});
	}
	throw new AgentCliError({
		code: 'target_not_found',
		message: 'No connected PUMPD session matches the requested target.',
		retryable: true,
		recovery:
			'Run pumpd-devtools doctor and retry with a connectedSessions deviceId or reported Simulator UDID.',
	});
}

function simulatorByUdid(state: SimulatorState, udid: string) {
	const simulator = state.devices.find(
		(device) => device.udid.toLowerCase() === udid.toLowerCase()
	);
	if (!simulator) {
		throw new AgentCliError({
			code: 'target_not_found',
			message:
				'The requested Simulator is not present in the fresh local inventory.',
			retryable: true,
		});
	}
	return simulator;
}

function actionId(requestId: string): string {
	return `agent-${requestId}-${randomUUID()}`.slice(0, 256);
}

async function dispatchConnectedAction(
	broker: BrokerPort,
	device: DeviceSession,
	requestId: string,
	action: { tool: string; command: string; payload: Record<string, unknown> }
): Promise<DesktopActionResult> {
	if (!isSafeAgentConnectedAction(action.tool, action.command)) {
		throw new AgentCliError({
			code: 'approval_required',
			message:
				'This connected-app action is not permitted through the unattended CLI.',
			recovery:
				'Run the action from the desktop app so its confirmation can be shown.',
		});
	}
	const parsed = desktopActionSchema.parse({
		actionId: actionId(requestId),
		deviceId: device.info.id,
		...action,
	});
	const result = await broker.dispatchAction(parsed);
	if (!result.ok) {
		throw new AgentCliError({
			code: 'action_failed',
			message: result.error ?? 'The connected-app action failed.',
			retryable: true,
		});
	}
	return result;
}

async function dispatchConnectedWait(
	broker: BrokerPort,
	device: DeviceSession,
	requestId: string,
	action: { tool: string; command: string; payload: Record<string, unknown> },
	timeoutMs: number,
	signal: AbortSignal
): Promise<DesktopActionResult> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	do {
		if (signal.aborted) throw abortError();
		const remainingMs = Math.max(1, deadline - Date.now());
		try {
			return await dispatchConnectedAction(broker, device, requestId, {
				...action,
				payload: {
					...action.payload,
					timeoutMs: Math.min(CONNECTED_WAIT_SLICE_MS, remainingMs),
				},
			});
		} catch (error) {
			if (!(error instanceof AgentCliError) || error.code !== 'action_failed') {
				throw error;
			}
			lastError = error;
		}
	} while (Date.now() < deadline);
	throw (
		lastError ??
		new AgentCliError({
			code: 'action_failed',
			message: 'The connected-app wait timed out.',
			retryable: true,
		})
	);
}

function abortError(): AgentCliError {
	return new AgentCliError({
		code: 'cancelled',
		message: 'The agent request was cancelled.',
		retryable: true,
	});
}

async function waitForSimulatorJob(
	service: SimulatorPort,
	jobId: string,
	signal: AbortSignal
): Promise<SimulatorJob> {
	return await waitForJob(
		() => service.getState().jobs.find((job) => job.id === jobId),
		(listener) => service.subscribe(listener),
		signal
	);
}

async function waitForSlimmingJob(
	service: SlimmingPort,
	jobId: string,
	signal: AbortSignal
): Promise<SlimmingJob> {
	return await waitForJob(
		() => service.getState().jobs.find((job) => job.id === jobId),
		(listener) => service.subscribe(listener),
		signal
	);
}

async function waitForJob<T extends { status: string }>(
	find: () => T | undefined,
	subscribe: (listener: () => void) => () => void,
	signal: AbortSignal
): Promise<T> {
	const current = find();
	if (current && TERMINAL_JOB_STATUSES.has(current.status)) return current;
	return await new Promise<T>((resolve, reject) => {
		let unsubscribe: () => void = () => undefined;
		const settle = () => {
			const job = find();
			if (!job || !TERMINAL_JOB_STATUSES.has(job.status)) return;
			cleanup();
			resolve(job);
		};
		const onAbort = () => {
			cleanup();
			reject(abortError());
		};
		const cleanup = () => {
			unsubscribe();
			signal.removeEventListener('abort', onAbort);
		};
		unsubscribe = subscribe(settle);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
		else settle();
	});
}

async function runSimulatorAction(
	service: SimulatorPort,
	action: SimulatorAction,
	signal: AbortSignal,
	wait = true
): Promise<SimulatorActionReceipt | SimulatorJob> {
	const receipt = service.runAction(action);
	if (!receipt.accepted || !receipt.jobId) {
		throw new AgentCliError({
			code: 'action_rejected',
			message: receipt.error ?? 'The Simulator action was rejected.',
			retryable: true,
		});
	}
	return wait
		? await waitForSimulatorJob(service, receipt.jobId, signal)
		: receipt;
}

async function runSlimmingAction(
	service: SlimmingPort,
	action: SlimmingAction,
	signal: AbortSignal
): Promise<SlimmingJob> {
	const receipt = service.runAction(action);
	if (!receipt.accepted || !receipt.jobId) {
		throw new AgentCliError({
			code: 'action_rejected',
			message:
				receipt.error ??
				'The read-only Simulator Slimming action was rejected.',
			retryable: true,
		});
	}
	return await waitForSlimmingJob(service, receipt.jobId, signal);
}

function ensureComplete<T extends { status: string; message: string }>(
	job: T
): T {
	if (job.status === 'complete') return job;
	throw new AgentCliError({
		code: job.status === 'cancelled' ? 'cancelled' : 'action_failed',
		message: job.message,
		retryable: job.status !== 'needs-attention',
	});
}

function captureForJob(
	state: SimulatorState,
	job: SimulatorJob
): SimulatorCapture {
	const capture = state.captures.find(
		(candidate) => candidate.id === job.captureId
	);
	if (!capture) {
		throw new AgentCliError({
			code: 'capture_missing',
			message: 'The capture job completed without published capture metadata.',
			retryable: true,
		});
	}
	return capture;
}

function compactSimulatorState(
	state: SimulatorState,
	includeUnavailable: boolean
) {
	return {
		capability: state.capability,
		updatedAt: state.updatedAt,
		devices: state.devices
			.filter((device) => includeUnavailable || device.isAvailable)
			.map((device) => ({
				...device,
				metrics: state.metrics.byDevice[device.udid],
				apps: state.appsByDevice[device.udid]?.length ?? 0,
			})),
	};
}

function compactScreen(device: DeviceSession) {
	return {
		device: device.info,
		status: device.status,
		lastSeenAt: device.lastSeenAt,
		screenHash: device.tools.componentSummary.screenHash,
		componentSummary: device.tools.componentSummary,
		activeRoute: device.tools.routes.find((route) => route.isCurrent),
		viewport: device.info.viewport,
	};
}

function compactConnectedSession(device: DeviceSession) {
	return {
		deviceId: device.info.id,
		name: device.info.name,
		platform: device.info.platform,
		status: device.status,
		lastSeenAt: device.lastSeenAt,
		...(device.info.appVersion ? { appVersion: device.info.appVersion } : {}),
		...(device.info.variant ? { variant: device.info.variant } : {}),
		...(device.info.simulatorUdid
			? { simulatorUdid: device.info.simulatorUdid }
			: {}),
		...(device.info.bundleIdentifier
			? { bundleIdentifier: device.info.bundleIdentifier }
			: {}),
		capabilities: device.info.capabilities,
	};
}

async function waitForNetworkIdle(
	broker: BrokerPort,
	device: DeviceSession,
	quietMs: number,
	signal: AbortSignal
): Promise<{ idleAt: number }> {
	let quietSince = Date.now();
	while (!signal.aborted) {
		const current = broker
			.getState()
			.devices.find((candidate) => candidate.info.id === device.info.id);
		if (!current || current.status === 'offline') {
			throw new AgentCliError({
				code: 'device_offline',
				message:
					'The PUMPD session disconnected while waiting for network idle.',
				retryable: true,
			});
		}
		if (current.tools.network.some((entry) => entry.state === 'pending')) {
			quietSince = Date.now();
		} else if (Date.now() - quietSince >= quietMs) {
			return { idleAt: Date.now() };
		}
		await new Promise<void>((resolve, reject) => {
			const cleanup = () => signal.removeEventListener('abort', onAbort);
			const timer = setTimeout(
				() => {
					cleanup();
					resolve();
				},
				Math.min(quietMs, 250)
			);
			const onAbort = () => {
				clearTimeout(timer);
				cleanup();
				reject(abortError());
			};
			signal.addEventListener('abort', onAbort, { once: true });
		});
	}
	throw abortError();
}

export function createAgentCommandRouter({
	broker,
	simulator,
	slimming,
	recipes,
}: AgentCommandRouterDependencies): AgentCliHandler {
	return async (command, context) => {
		switch (command.kind) {
			case 'doctor': {
				const [simulatorState, slimmingState] = await Promise.all([
					simulator.refresh(),
					slimming.refresh(),
				]);
				const brokerState = broker.getState();
				const { urls: _urls, ...brokerSummary } = brokerState.broker;
				const connectedSessions = brokerState.devices
					.filter((device) => device.status !== 'offline')
					.map(compactConnectedSession);
				return {
					broker: brokerSummary,
					connectedDevices: connectedSessions.length,
					connectedSessions,
					simulator: simulatorState.capability,
					native: simulatorState.native,
					slimming: slimmingState.helper,
				};
			}
			case 'simulators': {
				return compactSimulatorState(
					await simulator.refresh(),
					command.includeUnavailable
				);
			}
			case 'apps': {
				const fresh = await simulator.refresh();
				const target = simulatorByUdid(fresh, command.udid);
				const job = ensureComplete(
					(await runSimulatorAction(
						simulator,
						{
							actionId: actionId(context.requestId),
							kind: 'app.list',
							udid: target.udid,
						},
						context.signal
					)) as SimulatorJob
				);
				return {
					job,
					apps: simulator.getState().appsByDevice[target.udid] ?? [],
				};
			}
			case 'screen': {
				return compactScreen(
					connectedDeviceForTarget(broker.getState(), command.target)
				);
			}
			case 'elements': {
				const device = connectedDeviceForTarget(
					broker.getState(),
					command.target
				);
				const query = command.query?.trim().toLowerCase();
				const elements = device.tools.components
					.filter(
						(element) =>
							!query ||
							[
								element.name,
								element.testID,
								element.accessibilityLabel,
								element.accessibilityRole,
								element.route,
							]
								.filter(Boolean)
								.join(' ')
								.toLowerCase()
								.includes(query)
					)
					.slice(0, command.limit);
				return {
					screenHash: device.tools.componentSummary.screenHash,
					truncated:
						device.tools.componentSummary.truncated ||
						elements.length < device.tools.components.length,
					elements,
				};
			}
			case 'act': {
				const device = connectedDeviceForTarget(
					broker.getState(),
					command.target
				);
				return await dispatchConnectedAction(
					broker,
					device,
					context.requestId,
					command.action
				);
			}
			case 'wait': {
				if (command.condition.kind === 'job') {
					const jobId = command.condition.jobId;
					const simulatorJob = simulator
						.getState()
						.jobs.find((job) => job.id === jobId);
					if (simulatorJob) {
						return await waitForSimulatorJob(simulator, jobId, context.signal);
					}
					const slimmingJob = slimming
						.getState()
						.jobs.find((job) => job.id === jobId);
					if (slimmingJob) {
						return await waitForSlimmingJob(slimming, jobId, context.signal);
					}
					throw new AgentCliError({
						code: 'target_not_found',
						message: 'The requested job was not found.',
						retryable: true,
					});
				}
				if (!command.target)
					required('This wait condition requires an exact target.');
				const device = connectedDeviceForTarget(
					broker.getState(),
					command.target
				);
				if (command.condition.kind === 'network-idle') {
					return await waitForNetworkIdle(
						broker,
						device,
						command.condition.quietMs,
						context.signal
					);
				}
				const action =
					command.condition.kind === 'element'
						? {
								tool: 'components',
								command: 'waitForElement',
								payload: {
									id: command.condition.elementId,
									timeoutMs: command.timeoutMs,
								},
							}
						: {
								tool: 'components',
								command: 'waitForScreenChange',
								payload: {
									screenHash: command.condition.screenHash,
									timeoutMs: command.timeoutMs,
								},
							};
				return await dispatchConnectedWait(
					broker,
					device,
					context.requestId,
					action,
					command.timeoutMs,
					context.signal
				);
			}
			case 'capture': {
				const state = await simulator.refresh();
				const target = simulatorByUdid(state, command.udid);
				const job = ensureComplete(
					(await runSimulatorAction(
						simulator,
						{
							actionId: actionId(context.requestId),
							kind: 'capture.screenshot',
							udid: target.udid,
							format: command.format,
							mask: 'alpha',
							...(command.name ? { name: command.name } : {}),
						},
						context.signal
					)) as SimulatorJob
				);
				return { job, capture: captureForJob(simulator.getState(), job) };
			}
			case 'record': {
				if (command.operation === 'start') {
					const state = await simulator.refresh();
					const target = simulatorByUdid(state, command.udid);
					return await runSimulatorAction(
						simulator,
						{
							actionId: actionId(context.requestId),
							kind: 'capture.video',
							udid: target.udid,
							codec: command.codec,
							mask: 'black',
							...(command.name ? { name: command.name } : {}),
						},
						context.signal,
						false
					);
				}
				const target = simulatorByUdid(await simulator.refresh(), command.udid);
				const candidate = command.jobId
					? simulator
							.getState()
							.jobs.find((candidate) => candidate.id === command.jobId)
					: simulator
							.getState()
							.jobs.find(
								(candidate) =>
									candidate.kind === 'capture.video' &&
									candidate.deviceUdid === target.udid &&
									!TERMINAL_JOB_STATUSES.has(candidate.status)
							);
				const job =
					candidate?.kind === 'capture.video' &&
					candidate.deviceUdid === target.udid &&
					!TERMINAL_JOB_STATUSES.has(candidate.status)
						? candidate
						: undefined;
				if (!job)
					required('No active recording matches this target and jobId.');
				if (!simulator.cancelJob(job.id))
					required('The recording is no longer active.');
				const finished = await waitForSimulatorJob(
					simulator,
					job.id,
					context.signal
				);
				return {
					job: finished,
					...(finished.captureId
						? { capture: captureForJob(simulator.getState(), finished) }
						: {}),
				};
			}
			case 'network': {
				const device = connectedDeviceForTarget(
					broker.getState(),
					command.target
				);
				if (command.operation === 'status') {
					return (
						device.tools.networkProfile ?? {
							id: 'none',
							name: 'No profile',
							active: false,
							scope: 'instrumented-fetch',
						}
					);
				}
				return await dispatchConnectedAction(
					broker,
					device,
					context.requestId,
					command.operation === 'clear'
						? { tool: 'network', command: 'clearProfile', payload: {} }
						: {
								tool: 'network',
								command: 'setProfile',
								payload: { profileId: command.profileId },
							}
				);
			}
			case 'jobs': {
				const jobs = [
					...simulator
						.getState()
						.jobs.map((job) => ({ source: 'simulator', ...job })),
					...slimming
						.getState()
						.jobs.map((job) => ({ source: 'slimming', ...job })),
				];
				if (command.operation === 'list') return jobs;
				if (!command.jobId) required('jobs get and cancel require jobId.');
				const job = jobs.find((candidate) => candidate.id === command.jobId);
				if (!job) unavailable('The requested job was not found.');
				if (command.operation === 'get') return job;
				return {
					cancelled:
						simulator.cancelJob(command.jobId) ||
						slimming.cancelJob(command.jobId),
				};
			}
			case 'slimming': {
				if (command.operation === 'status') return await slimming.refresh();
				if (!command.udids?.length) {
					required(
						'Slimming preview, doctor, and verify require one or more udids.'
					);
				}
				const simulatorInventory = await simulator.refresh();
				const canonicalUdids = command.udids.map(
					(udid) => simulatorByUdid(simulatorInventory, udid).udid
				);
				const action: SlimmingAction =
					command.operation === 'doctor'
						? {
								actionId: actionId(context.requestId),
								kind: 'doctor.run',
								simulatorUdids: canonicalUdids,
								requiredCapabilities: [...ALL_DOCTOR_CAPABILITIES],
							}
						: {
								actionId: actionId(context.requestId),
								kind:
									command.operation === 'preview'
										? 'profile.preview'
										: 'profile.verify',
								simulatorUdids: canonicalUdids,
								profileId:
									command.profileId ??
									required('Slimming preview and verify require profileId.'),
							};
				const job = ensureComplete(
					await runSlimmingAction(slimming, action, context.signal)
				);
				const state = slimming.getState();
				return {
					job,
					statusBySimulator: Object.fromEntries(
						canonicalUdids.map((udid) => [udid, state.statusBySimulator[udid]])
					),
					previewBySimulator: Object.fromEntries(
						canonicalUdids.map((udid) => [udid, state.previewBySimulator[udid]])
					),
					doctorBySimulator: Object.fromEntries(
						canonicalUdids.map((udid) => [udid, state.doctorBySimulator[udid]])
					),
				};
			}
			case 'recipe': {
				if (!recipes) {
					unavailable(
						'The local recipe provider is not installed.',
						'Create or import a recipe in the Automation workspace first.'
					);
				}
				switch (command.operation) {
					case 'list':
						return await recipes.list();
					case 'get':
						return await recipes.get(
							command.recipeId ?? required('recipe get requires recipeId.')
						);
					case 'run': {
						const recipeUdids =
							command.udids ??
							required('recipe run requires one or more udids.');
						const recipeInventory = await simulator.refresh();
						return await recipes.run(
							command.recipeId ?? required('recipe run requires recipeId.'),
							recipeUdids.map(
								(udid) => simulatorByUdid(recipeInventory, udid).udid
							)
						);
					}
					case 'cancel':
						return await recipes.cancel(
							command.runId ?? required('recipe cancel requires runId.')
						);
					case 'status':
						return await recipes.status(command.runId);
				}
			}
		}
	};
}
