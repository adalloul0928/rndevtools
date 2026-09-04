import { contextBridge, ipcRenderer } from 'electron';
import {
	type BuildInsightsBridge,
	type BuildInsightsOperation,
	type BuildInsightsOperationReceipt,
	type BuildInsightsState,
	buildInsightsOperationReceiptSchema,
	buildInsightsOperationSchema,
	buildInsightsStateSchema,
} from '../shared/build-insights-protocol';
import { IPC_CHANNELS } from '../shared/ipc';
import {
	type DesktopAction,
	type DesktopActionResult,
	type DesktopBootstrap,
	type DesktopBridge,
	type DesktopState,
	desktopActionResultSchema,
	desktopActionSchema,
	desktopBootstrapSchema,
	desktopStateSchema,
} from '../shared/protocol';
import {
	type RecipeBridge,
	type RecipeDefinition,
	type RecipeEvidenceManifest,
	type RecipeFileOperation,
	type RecipeFileOperationReceipt,
	type RecipeRunConfirmationResult,
	type RecipeRunReceipt,
	type RecipeRunRequest,
	type RecipeState,
	type RecipeSummary,
	recipeDefinitionSchema,
	recipeEvidenceIdSchema,
	recipeEvidenceManifestSchema,
	recipeFileOperationReceiptSchema,
	recipeFileOperationSchema,
	recipeIdSchema,
	recipeRunConfirmationResultSchema,
	recipeRunIdSchema,
	recipeRunReceiptSchema,
	recipeRunRequestSchema,
	recipeStateSchema,
	recipeSummarySchema,
} from '../shared/recipe-protocol';
import {
	type SimulatorAction,
	type SimulatorActionReceipt,
	type SimulatorBridge,
	type SimulatorCaptureAccessResult,
	type SimulatorCaptureOperation,
	type SimulatorCaptureOperationReceipt,
	type SimulatorCaptureRetentionState,
	type SimulatorConfirmationResult,
	type SimulatorOnboardingOperation,
	type SimulatorOnboardingReceipt,
	type SimulatorState,
	simulatorActionReceiptSchema,
	simulatorActionSchema,
	simulatorCaptureAccessResultSchema,
	simulatorCaptureIdSchema,
	simulatorCaptureOperationReceiptSchema,
	simulatorCaptureOperationSchema,
	simulatorCaptureRetentionStateSchema,
	simulatorConfirmationResultSchema,
	simulatorJobIdSchema,
	simulatorOnboardingOperationSchema,
	simulatorOnboardingReceiptSchema,
	simulatorStateSchema,
} from '../shared/simulator-protocol';
import {
	type SlimmingAcknowledgementReceipt,
	type SlimmingAcknowledgementRequest,
	type SlimmingAction,
	type SlimmingActionReceipt,
	type SlimmingBridge,
	type SlimmingConfirmationResult,
	type SlimmingConfirmationTarget,
	type SlimmingSettingReceipt,
	type SlimmingSettingRequest,
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
	slimmingStateSchema,
} from '../shared/slimming-protocol';

const bridge: DesktopBridge &
	SimulatorBridge &
	SlimmingBridge &
	RecipeBridge &
	BuildInsightsBridge = {
	getBootstrap: async () =>
		desktopBootstrapSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getBootstrap)
		) as DesktopBootstrap,
	subscribe: (listener: (state: DesktopState) => void) => {
		if (typeof listener !== 'function') {
			throw new TypeError('Desktop state listener must be a function.');
		}
		const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => {
			const parsed = desktopStateSchema.safeParse(state);
			if (!parsed.success) return;
			try {
				listener(parsed.data);
			} catch {
				// A renderer callback must not break the isolated IPC event handler.
			}
		};
		ipcRenderer.on(IPC_CHANNELS.stateChanged, wrapped);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.stateChanged, wrapped);
	},
	runAction: async (action: DesktopAction) => {
		const validatedAction = desktopActionSchema.parse(action);
		return desktopActionResultSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runAction, validatedAction)
		) as DesktopActionResult;
	},
	getSimulatorState: async () =>
		simulatorStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getSimulatorState)
		) as SimulatorState,
	subscribeSimulatorState: (listener: (state: SimulatorState) => void) => {
		if (typeof listener !== 'function') {
			throw new TypeError('Simulator state listener must be a function.');
		}
		const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => {
			const parsed = simulatorStateSchema.safeParse(state);
			if (!parsed.success) return;
			try {
				listener(parsed.data);
			} catch {
				// A renderer callback must not break the isolated IPC event handler.
			}
		};
		ipcRenderer.on(IPC_CHANNELS.simulatorStateChanged, wrapped);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.simulatorStateChanged, wrapped);
	},
	refreshSimulators: async () =>
		simulatorStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.refreshSimulators)
		) as SimulatorState,
	requestSimulatorConfirmation: async (action: SimulatorAction) => {
		const validatedAction = simulatorActionSchema.parse(action);
		return simulatorConfirmationResultSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.requestSimulatorConfirmation,
				validatedAction
			)
		) as SimulatorConfirmationResult;
	},
	runSimulatorAction: async (action: SimulatorAction) => {
		const validatedAction = simulatorActionSchema.parse(action);
		return simulatorActionReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runSimulatorAction, validatedAction)
		) as SimulatorActionReceipt;
	},
	cancelSimulatorJob: async (jobId: string) => {
		const validatedJobId = simulatorJobIdSchema.parse(jobId);
		return Boolean(
			await ipcRenderer.invoke(IPC_CHANNELS.cancelSimulatorJob, validatedJobId)
		);
	},
	getSimulatorCaptureAccess: async (captureId: string) => {
		const validatedCaptureId = simulatorCaptureIdSchema.parse(captureId);
		return simulatorCaptureAccessResultSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.getSimulatorCaptureAccess,
				validatedCaptureId
			)
		) as SimulatorCaptureAccessResult;
	},
	getSimulatorCaptureRetention: async () =>
		simulatorCaptureRetentionStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getSimulatorCaptureRetention)
		) as SimulatorCaptureRetentionState,
	runSimulatorCaptureOperation: async (operation: SimulatorCaptureOperation) => {
		const validatedOperation = simulatorCaptureOperationSchema.parse(operation);
		return simulatorCaptureOperationReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.runSimulatorCaptureOperation,
				validatedOperation
			)
		) as SimulatorCaptureOperationReceipt;
	},
	runSimulatorOnboardingOperation: async (operation: SimulatorOnboardingOperation) => {
		const validatedOperation = simulatorOnboardingOperationSchema.parse(operation);
		return simulatorOnboardingReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.runSimulatorOnboardingOperation,
				validatedOperation
			)
		) as SimulatorOnboardingReceipt;
	},
	getSlimmingState: async () =>
		slimmingStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getSlimmingState)
		) as SlimmingState,
	subscribeSlimmingState: (listener: (state: SlimmingState) => void) => {
		if (typeof listener !== 'function') {
			throw new TypeError('Slimming state listener must be a function.');
		}
		const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => {
			const parsed = slimmingStateSchema.safeParse(state);
			if (!parsed.success) return;
			try {
				listener(parsed.data);
			} catch {
				// A renderer callback must not break the isolated IPC event handler.
			}
		};
		ipcRenderer.on(IPC_CHANNELS.slimmingStateChanged, wrapped);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.slimmingStateChanged, wrapped);
	},
	refreshSlimming: async () =>
		slimmingStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.refreshSlimming)
		) as SlimmingState,
	setSlimmingEnabled: async (request: SlimmingSettingRequest) => {
		const validated = slimmingSettingRequestSchema.parse(request);
		return slimmingSettingReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.setSlimmingEnabled, validated)
		) as SlimmingSettingReceipt;
	},
	acknowledgeSlimmingCompatibility: async (request: SlimmingAcknowledgementRequest) => {
		const validated = slimmingAcknowledgementRequestSchema.parse(request);
		return slimmingAcknowledgementReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.acknowledgeSlimmingCompatibility, validated)
		) as SlimmingAcknowledgementReceipt;
	},
	requestSlimmingConfirmation: async (target: SlimmingConfirmationTarget) => {
		const validated = slimmingConfirmationTargetSchema.parse(target);
		return slimmingConfirmationResultSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.requestSlimmingConfirmation, validated)
		) as SlimmingConfirmationResult;
	},
	runSlimmingAction: async (action: SlimmingAction) => {
		const validated = slimmingActionSchema.parse(action);
		return slimmingActionReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runSlimmingAction, validated)
		) as SlimmingActionReceipt;
	},
	cancelSlimmingJob: async (jobId: string) => {
		const validated = slimmingJobIdSchema.parse(jobId);
		return Boolean(await ipcRenderer.invoke(IPC_CHANNELS.cancelSlimmingJob, validated));
	},
	getRecipeState: async () =>
		recipeStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getRecipeState)
		) as RecipeState,
	subscribeRecipeState: (listener: (state: RecipeState) => void) => {
		if (typeof listener !== 'function') {
			throw new TypeError('Recipe state listener must be a function.');
		}
		const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => {
			const parsed = recipeStateSchema.safeParse(state);
			if (!parsed.success) return;
			try {
				listener(parsed.data);
			} catch {
				// A renderer callback must not break the isolated IPC event handler.
			}
		};
		ipcRenderer.on(IPC_CHANNELS.recipeStateChanged, wrapped);
		return () => ipcRenderer.removeListener(IPC_CHANNELS.recipeStateChanged, wrapped);
	},
	getRecipe: async (recipeId: string) => {
		const result = await ipcRenderer.invoke(
			IPC_CHANNELS.getRecipe,
			recipeIdSchema.parse(recipeId)
		);
		return result === null
			? null
			: (recipeDefinitionSchema.parse(result) as RecipeDefinition);
	},
	getRecipeEvidence: async (evidenceId: string) => {
		const result = await ipcRenderer.invoke(
			IPC_CHANNELS.getRecipeEvidence,
			recipeEvidenceIdSchema.parse(evidenceId)
		);
		return result === null
			? null
			: (recipeEvidenceManifestSchema.parse(result) as RecipeEvidenceManifest);
	},
	saveRecipe: async (recipe: RecipeDefinition) =>
		recipeSummarySchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.saveRecipe,
				recipeDefinitionSchema.parse(recipe)
			)
		) as RecipeSummary,
	runRecipe: async (request: RecipeRunRequest) =>
		recipeRunReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.runRecipe,
				recipeRunRequestSchema.parse(request)
			)
		) as RecipeRunReceipt,
	requestRecipeRunConfirmation: async (request: RecipeRunRequest) =>
		recipeRunConfirmationResultSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.requestRecipeRunConfirmation,
				recipeRunRequestSchema.parse(request)
			)
		) as RecipeRunConfirmationResult,
	cancelRecipeRun: async (runId: string) =>
		Boolean(
			await ipcRenderer.invoke(
				IPC_CHANNELS.cancelRecipeRun,
				recipeRunIdSchema.parse(runId)
			)
		),
	runRecipeFileOperation: async (operation: RecipeFileOperation) =>
		recipeFileOperationReceiptSchema.parse(
			await ipcRenderer.invoke(
				IPC_CHANNELS.runRecipeFileOperation,
				recipeFileOperationSchema.parse(operation)
			)
		) as RecipeFileOperationReceipt,
	getBuildInsightsState: async () =>
		buildInsightsStateSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.getBuildInsightsState)
		) as BuildInsightsState,
	subscribeBuildInsightsState: (listener: (state: BuildInsightsState) => void) => {
		if (typeof listener !== 'function') {
			throw new TypeError('Build Insights state listener must be a function.');
		}
		const wrapped = (_event: Electron.IpcRendererEvent, state: unknown) => {
			const parsed = buildInsightsStateSchema.safeParse(state);
			if (!parsed.success) return;
			try {
				listener(parsed.data);
			} catch {
				// A renderer callback must not break the isolated IPC event handler.
			}
		};
		ipcRenderer.on(IPC_CHANNELS.buildInsightsStateChanged, wrapped);
		return () =>
			ipcRenderer.removeListener(IPC_CHANNELS.buildInsightsStateChanged, wrapped);
	},
	runBuildInsightsOperation: async (operation: BuildInsightsOperation) => {
		const validated = buildInsightsOperationSchema.parse(operation);
		return buildInsightsOperationReceiptSchema.parse(
			await ipcRenderer.invoke(IPC_CHANNELS.runBuildInsightsOperation, validated)
		) as BuildInsightsOperationReceipt;
	},
};

contextBridge.exposeInMainWorld('pumpdDesktop', Object.freeze(bridge));
