import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnosticErrorText } from '@rndevtools/core/redact';
import {
	app,
	BrowserWindow,
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	nativeTheme,
	net,
	protocol,
	shell,
	type WebContents,
} from 'electron';
import type { BuildInsightsState } from '../shared/build-insights-protocol';
import { IPC_CHANNELS } from '../shared/ipc';
import {
	DEFAULT_BROKER_HOST,
	DEFAULT_BROKER_PORT,
	type DesktopBootstrap,
	type DesktopState,
	desktopActionSchema,
} from '../shared/protocol';
import type {
	RecipeDefinition,
	RecipeEvidenceManifest,
	RecipeRunConfirmationResult,
	RecipeRunRequest,
	RecipeState,
	RecipeSummary,
} from '../shared/recipe-protocol';
import { recipeRunConfirmationResultSchema } from '../shared/recipe-protocol';
import {
	SIMULATOR_CAPTURE_PROTOCOL_SCHEME,
	type SimulatorAction,
	type SimulatorActionReceipt,
	type SimulatorConfirmationResult,
	type SimulatorState,
	simulatorActionReceiptSchema,
	simulatorActionSchema,
	simulatorConfirmationResultSchema,
	simulatorJobIdSchema,
} from '../shared/simulator-protocol';
import {
	type SlimmingAcknowledgementReceipt,
	type SlimmingActionReceipt,
	type SlimmingConfirmationResult,
	type SlimmingConfirmationTarget,
	type SlimmingSettingReceipt,
	type SlimmingState,
	slimmingAcknowledgementReceiptSchema,
	slimmingAcknowledgementRequestSchema,
	slimmingActionReceiptSchema,
	slimmingActionSchema,
	slimmingConfirmationResultSchema,
	slimmingConfirmationTargetSchema,
	slimmingJobIdSchema,
	slimmingSettingReceiptSchema,
	slimmingSettingRequestSchema,
} from '../shared/slimming-protocol';
import { ActionConfirmationStore } from './action-confirmation-store';
import { AgentCliService } from './agent-cli-service';
import { createAgentCommandRouter } from './agent-command-router';
import { DesktopBroker } from './broker';
import { createBuildInsightsIpcHandlers } from './build-insights-ipc';
import { BuildInsightsService } from './build-insights-service';
import { BuildInsightsStore } from './build-insights-store';
import { desktopActionConfirmationCopy } from './desktop-action-confirmation';
import { DesktopSettingsStore } from './desktop-settings-store';
import { verifyAgentCli } from './native-helper-trust';
import { NativeHostClient } from './native-host-client';
import { createRecipeIpcHandlers } from './recipe-ipc';
import { RecipeService } from './recipe-service';
import { RecipeStore } from './recipe-store';
import {
	PACKAGED_RENDERER_CONTENT_SECURITY_POLICY,
	PACKAGED_RENDERER_SCHEME,
	PACKAGED_RENDERER_URL,
	packagedRendererAssetPath,
	trustedDevelopmentRendererUrl,
	urlsMatchWithoutHash,
} from './security';
import { SimHelperClient } from './sim-helper-client';
import { createSimulatorCaptureIpcHandlers } from './simulator-capture-ipc';
import { serveSimulatorCaptureRequest } from './simulator-capture-protocol';
import { SimulatorCaptureStore } from './simulator-capture-store';
import {
	simulatorActionNeedsConfirmation,
	simulatorConfirmationCopy,
} from './simulator-confirmation';
import { SimulatorMutationCoordinator } from './simulator-mutation-coordinator';
import {
	createSimulatorOnboardingIpcHandlers,
	validateXcodeDeveloperDirectory,
} from './simulator-onboarding-ipc';
import { SimulatorService } from './simulator-service';
import { slimmingConfirmationCopy } from './slimming-confirmation';
import { SlimmingService } from './slimming-service';
import { StagedCertificateStore } from './staged-certificate-store';

protocol.registerSchemesAsPrivileged([
	{
		scheme: PACKAGED_RENDERER_SCHEME,
		privileges: {
			codeCache: true,
			secure: true,
			standard: true,
		},
	},
	{
		scheme: SIMULATOR_CAPTURE_PROTOCOL_SCHEME,
		privileges: {
			corsEnabled: true,
			secure: true,
			standard: true,
			stream: true,
			supportFetchAPI: true,
		},
	},
]);

const brokerToken = process.env.RNDEVTOOLS_TOKEN;
const broker = new DesktopBroker({
	host: process.env.RNDEVTOOLS_BIND_ADDRESS ?? DEFAULT_BROKER_HOST,
	port: Number(process.env.RNDEVTOOLS_PORT ?? DEFAULT_BROKER_PORT),
	...(brokerToken === undefined ? {} : { token: brokerToken }),
	allowWildcardBind: process.env.RNDEVTOOLS_ALLOW_WILDCARD === 'true',
	includeDemoDevice: process.env.RNDEVTOOLS_DEMO === 'true',
});
const windows = new Set<BrowserWindow>();
const confirmationStore = new ActionConfirmationStore();
let brokerStopped = false;
let shutdownStarted = false;
let simulatorService: SimulatorService | undefined;
let slimmingService: SlimmingService | undefined;
let recipeService: RecipeService | undefined;
let agentCliService: AgentCliService | undefined;
let buildInsightsService: BuildInsightsService | undefined;
let stagedCertificateStore: StagedCertificateStore | undefined;

function rendererEntryUrl(): string {
	return (
		trustedDevelopmentRendererUrl(
			process.env.ELECTRON_RENDERER_URL,
			app.isPackaged
		) ?? PACKAGED_RENDERER_URL
	);
}

function registerRendererProtocol(): void {
	const rendererRoot = path.join(__dirname, '../renderer');
	protocol.handle(PACKAGED_RENDERER_SCHEME, async (request) => {
		const assetPath = packagedRendererAssetPath(rendererRoot, request.url);
		if (!assetPath) {
			return new Response('Not found', {
				headers: { 'content-type': 'text/plain; charset=utf-8' },
				status: 404,
			});
		}
		const response = await net.fetch(pathToFileURL(assetPath).href);
		if (path.extname(assetPath).toLowerCase() !== '.html') return response;
		const headers = new Headers(response.headers);
		headers.set(
			'content-security-policy',
			PACKAGED_RENDERER_CONTENT_SECURITY_POLICY
		);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	});
}

function registerSimulatorCaptureProtocol(store: SimulatorCaptureStore): void {
	protocol.handle(SIMULATOR_CAPTURE_PROTOCOL_SCHEME, (request) =>
		serveSimulatorCaptureRequest(store, request)
	);
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
	const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
	if (!urlsMatchWithoutHash(senderUrl, rendererEntryUrl())) {
		throw new Error('Rejected IPC from an untrusted renderer.');
	}
}

function sendState(webContents: WebContents, state: DesktopState): void {
	if (webContents.isDestroyed()) return;
	try {
		webContents.send(IPC_CHANNELS.stateChanged, state);
	} catch {
		// A renderer can disappear between the destroyed check and send.
	}
}

function broadcastState(state: DesktopState): void {
	for (const window of windows) sendState(window.webContents, state);
}

function sendSimulatorState(
	webContents: WebContents,
	state: SimulatorState
): void {
	if (webContents.isDestroyed()) return;
	try {
		webContents.send(IPC_CHANNELS.simulatorStateChanged, state);
	} catch {
		// A renderer can disappear between the destroyed check and send.
	}
}

function broadcastSimulatorState(state: SimulatorState): void {
	for (const window of windows) sendSimulatorState(window.webContents, state);
}

function sendSlimmingState(
	webContents: WebContents,
	state: SlimmingState
): void {
	if (webContents.isDestroyed()) return;
	try {
		webContents.send(IPC_CHANNELS.slimmingStateChanged, state);
	} catch {
		// A renderer can disappear between the destroyed check and send.
	}
}

function broadcastSlimmingState(state: SlimmingState): void {
	for (const window of windows) sendSlimmingState(window.webContents, state);
}

function sendRecipeState(webContents: WebContents, state: RecipeState): void {
	if (webContents.isDestroyed()) return;
	try {
		webContents.send(IPC_CHANNELS.recipeStateChanged, state);
	} catch {
		// A renderer can disappear between the destroyed check and send.
	}
}

function broadcastRecipeState(state: RecipeState): void {
	for (const window of windows) sendRecipeState(window.webContents, state);
}

function sendBuildInsightsState(
	webContents: WebContents,
	state: BuildInsightsState
): void {
	if (webContents.isDestroyed()) return;
	try {
		webContents.send(IPC_CHANNELS.buildInsightsStateChanged, state);
	} catch {
		// A renderer can disappear between the destroyed check and send.
	}
}

function broadcastBuildInsightsState(state: BuildInsightsState): void {
	for (const window of windows)
		sendBuildInsightsState(window.webContents, state);
}

function ownerWindow(event: IpcMainInvokeEvent): BrowserWindow | undefined {
	return BrowserWindow.fromWebContents(event.sender) ?? undefined;
}

async function confirmCaptureDelete(
	event: IpcMainInvokeEvent,
	capture: { name: string }
): Promise<boolean> {
	const options: Electron.MessageBoxOptions = {
		type: 'warning',
		title: 'Delete this capture?',
		message: 'Delete this capture?',
		detail: `${capture.name} will be permanently removed from local capture storage.`,
		buttons: ['Cancel', 'Delete'],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showMessageBox(owner, options)
		: await dialog.showMessageBox(options);
	return result.response === 1;
}

async function selectCaptureExportDestination(
	event: IpcMainInvokeEvent,
	capture: { mimeType: string; name: string }
): Promise<string | undefined> {
	const extensions =
		capture.mimeType === 'image/png'
			? ['png']
			: capture.mimeType === 'image/jpeg'
				? ['jpeg', 'jpg']
				: ['mp4'];
	const options: Electron.SaveDialogOptions = {
		title: 'Export Simulator capture',
		buttonLabel: 'Export',
		defaultPath: capture.name,
		filters: [{ name: 'Simulator capture', extensions }],
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showSaveDialog(owner, options)
		: await dialog.showSaveDialog(options);
	return result.canceled ? undefined : result.filePath;
}

async function confirmCaptureRetentionUpdate(
	event: IpcMainInvokeEvent,
	policy: { maxAgeDays: number; maxTotalBytes: number },
	current: { captureCount: number }
): Promise<boolean> {
	const gibibytes = policy.maxTotalBytes / (1024 * 1024 * 1024);
	const options: Electron.MessageBoxOptions = {
		type: 'warning',
		title: 'Update capture retention?',
		message: 'Update capture retention?',
		detail: `Captures older than ${policy.maxAgeDays} day${policy.maxAgeDays === 1 ? '' : 's'} or beyond ${gibibytes.toFixed(1)} GiB will be removed immediately. ${current.captureCount} capture${current.captureCount === 1 ? '' : 's'} are currently stored.`,
		buttons: ['Cancel', 'Update Retention'],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showMessageBox(owner, options)
		: await dialog.showMessageBox(options);
	return result.response === 1;
}

async function confirmSimulatorAction(
	event: IpcMainInvokeEvent,
	action: SimulatorAction,
	target: { name: string; udid: string },
	certificate?: { sha256: string; sizeBytes: number; subject?: string }
): Promise<boolean> {
	const copy = simulatorConfirmationCopy(action, target, certificate);
	if (!copy) return true;
	const options: Electron.MessageBoxOptions = {
		type: 'warning',
		title: copy.title,
		message: copy.title,
		detail: copy.detail,
		buttons: ['Cancel', 'Continue'],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showMessageBox(owner, options)
		: await dialog.showMessageBox(options);
	return result.response === 1;
}

async function confirmSlimmingTarget(
	event: IpcMainInvokeEvent,
	target: SlimmingConfirmationTarget,
	profileName?: string
): Promise<boolean> {
	const copy = slimmingConfirmationCopy(target, profileName);
	if (!copy) return true;
	const options: Electron.MessageBoxOptions = {
		type: 'warning',
		title: copy.title,
		message: copy.title,
		detail: copy.detail,
		buttons: ['Cancel', 'Continue'],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showMessageBox(owner, options)
		: await dialog.showMessageBox(options);
	return result.response === 1;
}

async function requestRecipeRunConfirmation(
	event: IpcMainInvokeEvent,
	request: RecipeRunRequest,
	recipe: RecipeDefinition
): Promise<RecipeRunConfirmationResult> {
	const steps = [...recipe.steps, ...recipe.teardown];
	const mutationCount = steps.filter(
		(step) => step.kind === 'slimming.mutation'
	).length;
	const sensitiveSimulatorCount = steps.filter(
		(step) =>
			step.kind === 'simulator' &&
			(step.action.operation === 'keychain.reset' ||
				(step.action.operation === 'privacy.update' &&
					step.action.privacyOperation === 'reset'))
	).length;
	const restorePointMutationCount = steps.filter(
		(step) =>
			step.kind === 'restore-point' &&
			(step.operation === 'restore' || step.operation === 'remove')
	).length;
	const title =
		mutationCount > 0
			? 'Run a privileged experimental Simulator recipe?'
			: 'Run a privileged Simulator recipe?';
	const actionDescription = [
		mutationCount > 0
			? `${mutationCount} experimental SimSlim mutation step${mutationCount === 1 ? '' : 's'}`
			: undefined,
		sensitiveSimulatorCount > 0
			? `${sensitiveSimulatorCount} sensitive reset step${sensitiveSimulatorCount === 1 ? '' : 's'}`
			: undefined,
		restorePointMutationCount > 0
			? `${restorePointMutationCount} restore-point restore/removal step${restorePointMutationCount === 1 ? '' : 's'}`
			: undefined,
	]
		.filter((value): value is string => value !== undefined)
		.join(' and ');
	const options: Electron.MessageBoxOptions = {
		type: 'warning',
		title,
		message: title,
		detail: `${recipe.name} revision ${recipe.revision} contains ${actionDescription} and targets these exact Simulator UDIDs: ${request.targetUdids.join(', ')}. ${mutationCount > 0 ? 'SimSlim mutations remain serialized and verified by the signed helper.' : 'Sensitive resets will run only after this one-time exact confirmation.'}`,
		buttons: ['Cancel', 'Run Recipe'],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showMessageBox(owner, options)
		: await dialog.showMessageBox(options);
	if (result.response !== 1) {
		return recipeRunConfirmationResultSchema.parse({
			actionId: request.actionId,
			required: true,
			confirmed: false,
			error: 'Recipe run cancelled by the operator.',
		});
	}
	const confirmation = confirmationStore.issue('recipe', event.sender.id, {
		...request,
		recipeRevision: recipe.revision,
	});
	return recipeRunConfirmationResultSchema.parse({
		actionId: request.actionId,
		required: true,
		confirmed: true,
		token: confirmation.token,
		expiresAt: confirmation.expiresAt,
	});
}

async function confirmRecipeDelete(
	event: IpcMainInvokeEvent,
	recipe: RecipeSummary
): Promise<boolean> {
	const options: Electron.MessageBoxOptions = {
		type: 'warning',
		title: 'Delete this recipe?',
		message: 'Delete this recipe?',
		detail: `${recipe.name} revision ${recipe.revision} will be permanently removed. Existing run evidence remains in local history.`,
		buttons: ['Cancel', 'Delete'],
		defaultId: 0,
		cancelId: 0,
		noLink: true,
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showMessageBox(owner, options)
		: await dialog.showMessageBox(options);
	return result.response === 1;
}

async function selectRecipeImportPath(
	event: IpcMainInvokeEvent
): Promise<string | undefined> {
	const options: Electron.OpenDialogOptions = {
		title: 'Import recipe',
		buttonLabel: 'Import',
		properties: ['openFile'],
		filters: [{ name: 'Recipe JSON', extensions: ['json'] }],
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showOpenDialog(owner, options)
		: await dialog.showOpenDialog(options);
	return result.canceled ? undefined : result.filePaths[0];
}

async function selectRecipeExportDestination(
	event: IpcMainInvokeEvent,
	recipe: RecipeDefinition
): Promise<string | undefined> {
	const options: Electron.SaveDialogOptions = {
		title: 'Export recipe',
		buttonLabel: 'Export',
		defaultPath: `${recipe.id}.rndevtools-recipe.json`,
		filters: [{ name: 'Recipe JSON', extensions: ['json'] }],
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showSaveDialog(owner, options)
		: await dialog.showSaveDialog(options);
	return result.canceled ? undefined : result.filePath;
}

async function selectEvidenceExportDestination(
	event: IpcMainInvokeEvent,
	evidence: RecipeEvidenceManifest
): Promise<string | undefined> {
	const options: Electron.SaveDialogOptions = {
		title: 'Export evidence manifest',
		buttonLabel: 'Export',
		defaultPath: `${evidence.id}.rndevtools-evidence.json`,
		filters: [{ name: 'Evidence JSON', extensions: ['json'] }],
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showSaveDialog(owner, options)
		: await dialog.showSaveDialog(options);
	return result.canceled ? undefined : result.filePath;
}

async function selectBuildInsightsSource(
	event: IpcMainInvokeEvent,
	kind: 'derived-data-root' | 'xcresult'
): Promise<string | undefined> {
	const options: Electron.OpenDialogOptions = {
		title:
			kind === 'xcresult'
				? 'Import an Xcode result bundle'
				: 'Watch a DerivedData directory',
		buttonLabel: kind === 'xcresult' ? 'Import Result' : 'Watch Directory',
		properties: ['openDirectory'],
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showOpenDialog(owner, options)
		: await dialog.showOpenDialog(options);
	return result.canceled ? undefined : result.filePaths[0];
}

async function selectBuildInsightsExportDestination(
	event: IpcMainInvokeEvent,
	format: 'csv' | 'json'
): Promise<string | undefined> {
	const extension = format === 'csv' ? 'csv' : 'json';
	const options: Electron.SaveDialogOptions = {
		title: 'Export local Build Insights',
		buttonLabel: 'Export',
		defaultPath: `rndevtools-build-insights.${extension}`,
		filters: [
			{
				name:
					format === 'csv' ? 'Comma-separated values' : 'Build Insights JSON',
				extensions: [extension],
			},
		],
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showSaveDialog(owner, options)
		: await dialog.showSaveDialog(options);
	return result.canceled ? undefined : result.filePath;
}

async function selectXcodeApplication(
	event: IpcMainInvokeEvent
): Promise<string | undefined> {
	const options: Electron.OpenDialogOptions = {
		title: 'Choose an Xcode application',
		buttonLabel: 'Use Xcode',
		properties: ['openFile'],
		filters: [{ name: 'Xcode application', extensions: ['app'] }],
	};
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showOpenDialog(owner, options)
		: await dialog.showOpenDialog(options);
	return result.canceled ? undefined : result.filePaths[0];
}

async function selectSimulatorInput(
	event: IpcMainInvokeEvent,
	action: SimulatorAction
): Promise<string | undefined> {
	let options: Electron.OpenDialogOptions | undefined;
	if (action.kind === 'app.install') {
		options = {
			title: 'Select a Simulator application',
			buttonLabel: 'Install',
			properties: ['openFile'],
			filters: [{ name: 'iOS Simulator application', extensions: ['app'] }],
		};
	} else if (action.kind === 'keychain.addCertificate') {
		options = {
			title: 'Select a certificate',
			buttonLabel: 'Add Certificate',
			properties: ['openFile'],
			filters: [
				{ name: 'Certificates', extensions: ['cer', 'crt', 'der', 'pem'] },
			],
		};
	} else if (action.kind === 'location.importGpx') {
		options = {
			title: 'Select a GPX route',
			buttonLabel: 'Import Route',
			properties: ['openFile'],
			filters: [{ name: 'GPS Exchange Format', extensions: ['gpx'] }],
		};
	}
	if (!options) return undefined;
	const owner = ownerWindow(event);
	const result = owner
		? await dialog.showOpenDialog(owner, options)
		: await dialog.showOpenDialog(options);
	return result.canceled ? undefined : result.filePaths[0];
}

function rejectedSimulatorAction(
	action: SimulatorAction,
	error: string
): SimulatorActionReceipt {
	return simulatorActionReceiptSchema.parse({
		actionId: action.actionId,
		accepted: false,
		error,
	});
}

function registerIpc(
	simulator: SimulatorService,
	slimming: SlimmingService,
	recipes: RecipeService,
	buildInsights: BuildInsightsService,
	certificates: StagedCertificateStore,
	nativeResourceDirectory: string,
	settings: DesktopSettingsStore
): void {
	const captureHandlers = createSimulatorCaptureIpcHandlers({
		service: simulator,
		assertTrustedRenderer,
		confirmDelete: confirmCaptureDelete,
		confirmRetentionUpdate: confirmCaptureRetentionUpdate,
		selectExportDestination: selectCaptureExportDestination,
		revealPath: (capturePath) => shell.showItemInFolder(capturePath),
	});
	const recipeHandlers = createRecipeIpcHandlers({
		service: recipes,
		assertTrustedRenderer,
		requestRunConfirmation: requestRecipeRunConfirmation,
		consumeRunConfirmation: (event, request, recipe) =>
			confirmationStore.consume(
				'recipe',
				event.sender.id,
				{ ...request, recipeRevision: recipe.revision },
				request.confirmationToken
			),
		confirmDelete: confirmRecipeDelete,
		selectImportPath: selectRecipeImportPath,
		selectRecipeExportDestination,
		selectEvidenceExportDestination,
	});
	const buildInsightsHandlers = createBuildInsightsIpcHandlers({
		service: buildInsights,
		assertTrustedRenderer,
		selectXcresult: (event) => selectBuildInsightsSource(event, 'xcresult'),
		selectWatchRoot: (event) =>
			selectBuildInsightsSource(event, 'derived-data-root'),
		selectExportDestination: selectBuildInsightsExportDestination,
	});
	const simulatorOnboardingHandlers = createSimulatorOnboardingIpcHandlers({
		assertTrustedRenderer,
		selectXcodeApplication,
		activateXcodeDeveloperDirectory: async (developerDirectory) => {
			await settings.setXcodeDeveloperDirectory(developerDirectory);
			process.env.DEVELOPER_DIR = developerDirectory;
			await simulator.rediscover();
		},
		openPrivacySettings: async (permission) => {
			const pane = {
				screen_recording: 'Privacy_ScreenCapture',
				accessibility: 'Privacy_Accessibility',
				camera: 'Privacy_Camera',
				microphone: 'Privacy_Microphone',
			}[permission];
			await shell.openExternal(
				`x-apple.systempreferences:com.apple.preference.security?${pane}`
			);
		},
		revealAgentCli: async () => {
			const cli = await verifyAgentCli({
				resourceDirectory: nativeResourceDirectory,
				appVersion: app.getVersion(),
			});
			shell.showItemInFolder(cli.executablePath);
		},
	});
	ipcMain.handle(IPC_CHANNELS.getBootstrap, (event): DesktopBootstrap => {
		assertTrustedRenderer(event);
		return {
			state: broker.getState(),
			platform: process.platform,
			versions: {
				app: app.getVersion(),
				electron: process.versions.electron,
				chrome: process.versions.chrome,
				node: process.versions.node,
			},
		};
	});
	ipcMain.handle(IPC_CHANNELS.runAction, async (event, value: unknown) => {
		assertTrustedRenderer(event);
		const action = desktopActionSchema.parse(value);
		const confirmation = desktopActionConfirmationCopy(action);
		if (confirmation) {
			const options: Electron.MessageBoxOptions = {
				type: confirmation.destructive ? 'warning' : 'question',
				title: confirmation.title,
				message: confirmation.message,
				detail: confirmation.detail,
				buttons: ['Cancel', confirmation.confirmLabel],
				defaultId: 0,
				cancelId: 0,
				noLink: true,
			};
			const owner = ownerWindow(event);
			const result = owner
				? await dialog.showMessageBox(owner, options)
				: await dialog.showMessageBox(options);
			if (result.response !== 1) {
				return {
					actionId: action.actionId,
					ok: false,
					error: 'Action cancelled by the desktop operator.',
				};
			}
		}
		return broker.dispatchAction(action);
	});
	ipcMain.handle(IPC_CHANNELS.getSimulatorState, (event): SimulatorState => {
		assertTrustedRenderer(event);
		return simulator.getState();
	});
	ipcMain.handle(IPC_CHANNELS.refreshSimulators, async (event) => {
		assertTrustedRenderer(event);
		await Promise.all([simulator.refresh(), simulator.refreshNative()]);
		return simulator.refreshMetrics();
	});
	ipcMain.handle(
		IPC_CHANNELS.requestSimulatorConfirmation,
		async (event, value: unknown): Promise<SimulatorConfirmationResult> => {
			assertTrustedRenderer(event);
			const action = simulatorActionSchema.parse(value);
			if (action.confirmationToken) {
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: simulatorActionNeedsConfirmation(action),
					confirmed: false,
					error: 'Confirmation requests cannot reuse an existing token.',
				});
			}
			if (!simulatorActionNeedsConfirmation(action)) {
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: false,
					confirmed: true,
				});
			}
			if (!('udid' in action)) {
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: true,
					confirmed: false,
					error:
						'The destructive action does not identify an exact Simulator target.',
				});
			}
			let stagedCertificate:
				| Awaited<ReturnType<StagedCertificateStore['stage']>>
				| undefined;
			try {
				if (action.kind === 'keychain.addCertificate' && action.trustRoot) {
					const selectedPath = await selectSimulatorInput(event, action);
					if (!selectedPath) {
						return simulatorConfirmationResultSchema.parse({
							actionId: action.actionId,
							required: true,
							confirmed: false,
							error: 'File selection was cancelled.',
						});
					}
					stagedCertificate = await certificates.stage(
						selectedPath,
						event.sender.id
					);
					if (event.sender.isDestroyed()) {
						await stagedCertificate.cleanup();
						return simulatorConfirmationResultSchema.parse({
							actionId: action.actionId,
							required: true,
							confirmed: false,
							error: 'The requesting desktop window was closed.',
						});
					}
				}
				const target = await simulator.resolveConfirmationTarget(action.udid);
				if (
					!(await confirmSimulatorAction(
						event,
						action,
						target,
						stagedCertificate?.identity
					))
				) {
					await stagedCertificate?.cleanup();
					return simulatorConfirmationResultSchema.parse({
						actionId: action.actionId,
						required: true,
						confirmed: false,
						error: 'Action cancelled by the operator.',
					});
				}
				const confirmationTarget = {
					action,
					target,
					...(stagedCertificate
						? { certificate: stagedCertificate.identity }
						: {}),
				};
				const confirmation = confirmationStore.issue(
					'simulator',
					event.sender.id,
					confirmationTarget
				);
				if (action.kind === 'keychain.addCertificate' && stagedCertificate) {
					certificates.bind(
						confirmation.token,
						event.sender.id,
						action,
						stagedCertificate
					);
				}
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: true,
					confirmed: true,
					token: confirmation.token,
					expiresAt: confirmation.expiresAt,
				});
			} catch (error) {
				await stagedCertificate?.cleanup();
				return simulatorConfirmationResultSchema.parse({
					actionId: action.actionId,
					required: true,
					confirmed: false,
					error: diagnosticErrorText(error).slice(0, 512),
				});
			}
		}
	);
	ipcMain.handle(
		IPC_CHANNELS.runSimulatorAction,
		async (event, value: unknown): Promise<SimulatorActionReceipt> => {
			assertTrustedRenderer(event);
			const action = simulatorActionSchema.parse(value);
			let stagedCertificate:
				| Awaited<ReturnType<StagedCertificateStore['stage']>>
				| undefined;
			if (simulatorActionNeedsConfirmation(action)) {
				if (!('udid' in action)) {
					return rejectedSimulatorAction(
						action,
						'The destructive action does not identify an exact Simulator target.'
					);
				}
				if (action.kind === 'keychain.addCertificate' && action.trustRoot) {
					stagedCertificate = await certificates.claim(
						action.confirmationToken,
						event.sender.id,
						action
					);
				}
				let target: { name: string; udid: string };
				try {
					target = await simulator.resolveConfirmationTarget(action.udid);
				} catch {
					await stagedCertificate?.cleanup();
					return rejectedSimulatorAction(
						action,
						'The exact Simulator target is no longer present in the fresh inventory.'
					);
				}
				const confirmationTarget = {
					action,
					target,
					...(stagedCertificate
						? { certificate: stagedCertificate.identity }
						: action.kind === 'keychain.addCertificate'
							? { certificate: null }
							: {}),
				};
				if (
					!confirmationStore.consume(
						'simulator',
						event.sender.id,
						confirmationTarget,
						action.confirmationToken
					)
				) {
					await stagedCertificate?.cleanup();
					return rejectedSimulatorAction(
						action,
						'A fresh, exact action confirmation is required.'
					);
				}
			}
			let selectedPath: string | undefined;
			try {
				selectedPath = stagedCertificate
					? undefined
					: await selectSimulatorInput(event, action);
			} catch (error) {
				await stagedCertificate?.cleanup();
				throw error;
			}
			if (
				(action.kind === 'app.install' ||
					action.kind === 'keychain.addCertificate' ||
					action.kind === 'location.importGpx') &&
				!selectedPath &&
				!stagedCertificate
			) {
				return rejectedSimulatorAction(action, 'File selection was cancelled.');
			}
			let rawReceipt: SimulatorActionReceipt;
			try {
				rawReceipt = simulator.runAction(action, {
					...(stagedCertificate
						? { materializeCertificatePath: stagedCertificate.materialize }
						: {}),
					...(selectedPath ? { selectedPath } : {}),
					...(stagedCertificate
						? { cleanupSelectedInput: stagedCertificate.cleanup }
						: {}),
				});
			} catch (error) {
				await stagedCertificate?.cleanup();
				throw error;
			}
			const receipt = simulatorActionReceiptSchema.parse(rawReceipt);
			if (!receipt.accepted) await stagedCertificate?.cleanup();
			return receipt;
		}
	);
	ipcMain.handle(IPC_CHANNELS.cancelSimulatorJob, (event, value: unknown) => {
		assertTrustedRenderer(event);
		return simulator.cancelJob(simulatorJobIdSchema.parse(value));
	});
	ipcMain.handle(
		IPC_CHANNELS.getSimulatorCaptureAccess,
		captureHandlers.getAccess
	);
	ipcMain.handle(
		IPC_CHANNELS.getSimulatorCaptureRetention,
		captureHandlers.getRetention
	);
	ipcMain.handle(
		IPC_CHANNELS.runSimulatorCaptureOperation,
		captureHandlers.runOperation
	);
	ipcMain.handle(
		IPC_CHANNELS.runSimulatorOnboardingOperation,
		simulatorOnboardingHandlers.runOperation
	);
	ipcMain.handle(IPC_CHANNELS.getSlimmingState, (event): SlimmingState => {
		assertTrustedRenderer(event);
		return slimming.getState();
	});
	ipcMain.handle(IPC_CHANNELS.refreshSlimming, async (event) => {
		assertTrustedRenderer(event);
		return slimming.refresh();
	});
	ipcMain.handle(
		IPC_CHANNELS.requestSlimmingConfirmation,
		async (event, value: unknown): Promise<SlimmingConfirmationResult> => {
			assertTrustedRenderer(event);
			const target = slimmingConfirmationTargetSchema.parse(value);
			if ('confirmationToken' in target && target.confirmationToken) {
				return slimmingConfirmationResultSchema.parse({
					actionId: target.actionId,
					required: Boolean(slimmingConfirmationCopy(target)),
					confirmed: false,
					error: 'Confirmation requests cannot reuse an existing token.',
				});
			}
			const profileName =
				'profileId' in target
					? slimming
							.getState()
							.profiles.find((profile) => profile.id === target.profileId)?.name
					: undefined;
			if (!slimmingConfirmationCopy(target, profileName)) {
				return slimmingConfirmationResultSchema.parse({
					actionId: target.actionId,
					required: false,
					confirmed: true,
				});
			}
			if (!(await confirmSlimmingTarget(event, target, profileName))) {
				return slimmingConfirmationResultSchema.parse({
					actionId: target.actionId,
					required: true,
					confirmed: false,
					error: 'Action cancelled by the operator.',
				});
			}
			const confirmation = confirmationStore.issue(
				'slimming',
				event.sender.id,
				target
			);
			return slimmingConfirmationResultSchema.parse({
				actionId: target.actionId,
				required: true,
				confirmed: true,
				token: confirmation.token,
				expiresAt: confirmation.expiresAt,
			});
		}
	);
	ipcMain.handle(
		IPC_CHANNELS.setSlimmingEnabled,
		async (event, value: unknown): Promise<SlimmingSettingReceipt> => {
			assertTrustedRenderer(event);
			const request = slimmingSettingRequestSchema.parse(value);
			if (
				!request.enabled &&
				request.disposition === 'restore-and-verify' &&
				!confirmationStore.consume(
					'slimming',
					event.sender.id,
					request,
					request.confirmationToken
				)
			) {
				return slimmingSettingReceiptSchema.parse({
					actionId: request.actionId,
					accepted: false,
					state: slimming.getState(),
					error: 'A fresh, exact restore confirmation is required.',
				});
			}
			return slimmingSettingReceiptSchema.parse(
				await slimming.setEnabled(request)
			);
		}
	);
	ipcMain.handle(
		IPC_CHANNELS.acknowledgeSlimmingCompatibility,
		async (event, value: unknown): Promise<SlimmingAcknowledgementReceipt> => {
			assertTrustedRenderer(event);
			const request = slimmingAcknowledgementRequestSchema.parse(value);
			return slimmingAcknowledgementReceiptSchema.parse(
				await slimming.acknowledgeCompatibility(request)
			);
		}
	);
	ipcMain.handle(
		IPC_CHANNELS.runSlimmingAction,
		(event, value: unknown): SlimmingActionReceipt => {
			assertTrustedRenderer(event);
			const action = slimmingActionSchema.parse(value);
			if (
				slimmingConfirmationCopy(action) &&
				!confirmationStore.consume(
					'slimming',
					event.sender.id,
					action,
					action.confirmationToken
				)
			) {
				return slimmingActionReceiptSchema.parse({
					actionId: action.actionId,
					accepted: false,
					error: 'A fresh, exact action confirmation is required.',
				});
			}
			return slimmingActionReceiptSchema.parse(slimming.runAction(action));
		}
	);
	ipcMain.handle(IPC_CHANNELS.cancelSlimmingJob, (event, value: unknown) => {
		assertTrustedRenderer(event);
		return slimming.cancelJob(slimmingJobIdSchema.parse(value));
	});
	ipcMain.handle(IPC_CHANNELS.getRecipeState, recipeHandlers.getState);
	ipcMain.handle(IPC_CHANNELS.getRecipe, recipeHandlers.getRecipe);
	ipcMain.handle(IPC_CHANNELS.getRecipeEvidence, recipeHandlers.getEvidence);
	ipcMain.handle(IPC_CHANNELS.saveRecipe, recipeHandlers.saveRecipe);
	ipcMain.handle(
		IPC_CHANNELS.requestRecipeRunConfirmation,
		recipeHandlers.requestRunConfirmation
	);
	ipcMain.handle(IPC_CHANNELS.runRecipe, recipeHandlers.runRecipe);
	ipcMain.handle(IPC_CHANNELS.cancelRecipeRun, recipeHandlers.cancelRun);
	ipcMain.handle(
		IPC_CHANNELS.runRecipeFileOperation,
		recipeHandlers.runFileOperation
	);
	ipcMain.handle(
		IPC_CHANNELS.getBuildInsightsState,
		buildInsightsHandlers.getState
	);
	ipcMain.handle(
		IPC_CHANNELS.runBuildInsightsOperation,
		buildInsightsHandlers.runOperation
	);
}

function updateSimulatorPolling(): void {
	const visible = [...windows].some(
		(window) =>
			!window.isDestroyed() && window.isVisible() && !window.isMinimized()
	);
	simulatorService?.setPollingActive(visible);
	slimmingService?.setPollingActive(visible);
}

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1480,
		height: 940,
		minWidth: 1040,
		minHeight: 700,
		show: false,
		backgroundColor: '#000000',
		title: 'RN Devtools',
		titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
		// Centers the 12px traffic lights in the 48px titlebar the renderer draws.
		trafficLightPosition: { x: 16, y: 18 },
		titleBarOverlay:
			process.platform === 'darwin'
				? false
				: { color: '#090909', symbolColor: '#a1a1a1', height: 48 },
		webPreferences: {
			preload: path.join(__dirname, '../preload/index.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			allowRunningInsecureContent: false,
			devTools: !app.isPackaged,
			navigateOnDragDrop: false,
			safeDialogs: true,
			spellcheck: false,
			webviewTag: false,
		},
	});
	windows.add(window);
	window.on('closed', () => {
		windows.delete(window);
		updateSimulatorPolling();
	});
	window.on('show', updateSimulatorPolling);
	window.on('hide', updateSimulatorPolling);
	window.on('minimize', updateSimulatorPolling);
	window.on('restore', updateSimulatorPolling);
	const senderId = window.webContents.id;
	stagedCertificateStore?.registerSender(senderId);
	window.webContents.once('destroyed', () => {
		confirmationStore.revokeSender(senderId);
		void stagedCertificateStore?.revokeSender(senderId);
	});
	window.once('ready-to-show', () => window.show());
	window.webContents.session.setPermissionRequestHandler(
		(webContents, permission, callback, details) => {
			callback(
				webContents === window.webContents &&
					details.isMainFrame &&
					urlsMatchWithoutHash(details.requestingUrl, rendererEntryUrl()) &&
					permission === 'clipboard-sanitized-write'
			);
		}
	);
	window.webContents.session.setPermissionCheckHandler(
		(webContents, permission, _requestingOrigin, details) =>
			webContents === window.webContents &&
			details.isMainFrame &&
			details.requestingUrl !== undefined &&
			urlsMatchWithoutHash(details.requestingUrl, rendererEntryUrl()) &&
			permission === 'clipboard-sanitized-write'
	);

	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-attach-webview', (event) =>
		event.preventDefault()
	);
	window.webContents.on('will-navigate', (event, url) => {
		if (!urlsMatchWithoutHash(url, rendererEntryUrl())) event.preventDefault();
	});
	window.webContents.on('will-redirect', (event, url) => {
		if (!urlsMatchWithoutHash(url, rendererEntryUrl())) event.preventDefault();
	});

	const rendererLoad = window.loadURL(rendererEntryUrl());
	void rendererLoad.catch((error: unknown) => {
		dialog.showErrorBox(
			'RN Devtools renderer could not load',
			diagnosticErrorText(error).slice(0, 8 * 1024)
		);
		if (!window.isDestroyed()) window.destroy();
		app.quit();
	});
	return window;
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		const window = BrowserWindow.getAllWindows()[0];
		if (!window) return;
		if (window.isMinimized()) window.restore();
		window.focus();
	});

	void app
		.whenReady()
		.then(async () => {
			nativeTheme.themeSource = 'dark';
			if (
				!trustedDevelopmentRendererUrl(
					process.env.ELECTRON_RENDERER_URL,
					app.isPackaged
				)
			) {
				registerRendererProtocol();
			}
			const settings = new DesktopSettingsStore(
				path.join(app.getPath('userData'), 'desktop-settings')
			);
			try {
				const storedSettings = await settings.load();
				if (storedSettings.xcodeDeveloperDirectory) {
					try {
						process.env.DEVELOPER_DIR = await validateXcodeDeveloperDirectory(
							storedSettings.xcodeDeveloperDirectory
						);
					} catch {
						await settings.setXcodeDeveloperDirectory(undefined);
					}
				}
			} catch {
				// Malformed settings fail closed without replacing caller-supplied toolchain state.
			}
			const nativeResourceDirectory = app.isPackaged
				? path.join(process.resourcesPath, 'native')
				: path.join(app.getAppPath(), 'build', 'native', `mac-${process.arch}`);
			const captureStore = new SimulatorCaptureStore(
				path.join(app.getPath('userData'), 'simulator-captures')
			);
			stagedCertificateStore = new StagedCertificateStore({
				directory: path.join(
					app.getPath('userData'),
					'simulator-staged-certificates'
				),
			});
			await stagedCertificateStore.start();
			registerSimulatorCaptureProtocol(captureStore);
			const nativeHostClient = new NativeHostClient({
				resourceDirectory: nativeResourceDirectory,
				appVersion: app.getVersion(),
				compositionWorkspaceDirectory: path.join(
					app.getPath('userData'),
					'Capture Design Studio',
					'workspaces'
				),
			});
			const simHelperClient = new SimHelperClient({
				resourceDirectory: nativeResourceDirectory,
				appVersion: app.getVersion(),
				mutationBroker: nativeHostClient,
			});
			const simulatorMutationCoordinator = new SimulatorMutationCoordinator();
			simulatorService = new SimulatorService({
				captureStore,
				nativeHostProvider: nativeHostClient,
				imageCompositor: nativeHostClient,
				cloneProvider: simHelperClient,
				diskProvider: simHelperClient,
				mutationCoordinator: simulatorMutationCoordinator,
			});
			slimmingService = new SlimmingService({
				...(!app.isPackaged
					? {
							mutationUnavailableReason:
								'Preview is available. Applying or restoring services requires a signed, packaged RN Devtools app.',
						}
					: {}),
				resourceDirectory: nativeResourceDirectory,
				persistenceDirectory: path.join(
					app.getPath('userData'),
					'simulator-slimming'
				),
				appVersion: app.getVersion(),
				helper: simHelperClient,
				mutationCoordinator: simulatorMutationCoordinator,
			});
			recipeService = new RecipeService({
				store: new RecipeStore(path.join(app.getPath('userData'), 'recipes')),
				broker,
				simulator: simulatorService,
				slimming: slimmingService,
				mutationCoordinator: simulatorMutationCoordinator,
			});
			buildInsightsService = new BuildInsightsService({
				store: new BuildInsightsStore(
					path.join(app.getPath('userData'), 'build-insights')
				),
			});
			agentCliService = new AgentCliService({
				socketPath: path.join(
					app.getPath('userData'),
					'agent',
					'rndevtools.sock'
				),
				handler: createAgentCommandRouter({
					broker,
					simulator: simulatorService,
					slimming: slimmingService,
					recipes: {
						list: () => recipeService?.getState().recipes ?? [],
						get: (recipeId) => recipeService?.getRecipe(recipeId) ?? null,
						run: (recipeId, udids) => {
							if (!recipeService)
								throw new Error('Recipe service is not available.');
							return recipeService.runRecipe({
								actionId: `agent-recipe-${randomUUID()}`,
								recipeId,
								targetUdids: [...udids],
								concurrency: Math.min(4, udids.length),
							});
						},
						cancel: (runId) => recipeService?.cancelRun(runId) ?? false,
						status: (runId) => {
							const runs = recipeService?.getState().runs ?? [];
							return runId
								? (runs.find((run) => run.id === runId) ?? null)
								: runs;
						},
					},
				}),
				...(app.isPackaged
					? {
							readiness: async () => {
								await verifyAgentCli({
									resourceDirectory: nativeResourceDirectory,
									appVersion: app.getVersion(),
								});
							},
						}
					: {}),
			});
			registerIpc(
				simulatorService,
				slimmingService,
				recipeService,
				buildInsightsService,
				stagedCertificateStore,
				nativeResourceDirectory,
				settings
			);
			broker.subscribe(broadcastState);
			simulatorService.subscribe(broadcastSimulatorState);
			slimmingService.subscribe(broadcastSlimmingState);
			recipeService.subscribe(broadcastRecipeState);
			buildInsightsService.subscribe(broadcastBuildInsightsState);
			await Promise.all([
				broker.start(),
				simulatorService.start(),
				slimmingService.start(),
				recipeService.start(),
				buildInsightsService.start(),
				agentCliService.start(),
			]);
			if (shutdownStarted) return;
			createWindow();

			app.on('activate', () => {
				if (!shutdownStarted && BrowserWindow.getAllWindows().length === 0) {
					createWindow();
				}
			});
		})
		.catch((error: unknown) => {
			dialog.showErrorBox(
				'RN Devtools could not start',
				diagnosticErrorText(error).slice(0, 8 * 1024)
			);
			app.quit();
		});
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
	if (brokerStopped) return;
	event.preventDefault();
	if (shutdownStarted) return;
	shutdownStarted = true;
	const simulatorShutdown = simulatorService?.stop();
	const certificateShutdown = simulatorShutdown
		? simulatorShutdown.finally(() => stagedCertificateStore?.stop())
		: stagedCertificateStore?.stop();
	void Promise.allSettled([
		broker.stop(),
		simulatorShutdown,
		slimmingService?.stop(),
		recipeService?.stop(),
		buildInsightsService?.stop(),
		agentCliService?.stop(),
		certificateShutdown,
	]).finally(() => {
		brokerStopped = true;
		app.quit();
	});
});
