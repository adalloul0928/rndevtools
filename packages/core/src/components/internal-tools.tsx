import {
	forwardRef,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from 'react';
import { StyleSheet, View } from 'react-native';
import { createActionServices } from '../core/action-services';
import {
	DEFAULT_PERSISTENCE_KEY,
	parsePersistedState,
	SerializedPersistenceWriter,
} from '../core/persistence';
import { PluginInstallerRegistry } from '../core/plugin-installer-registry';
import { assertUniquePluginIds, isPanelPlugin } from '../core/plugins';
import type {
	DevToolsPersistenceStorage,
	DevToolsPlugin,
	DevToolsPosition,
	DevToolsPresentationMode,
	InternalToolsHandle,
	InternalToolsProps,
} from '../types';
import { FloatingLauncher } from './floating-launcher';
import { FloatingWindow } from './floating-window';
import { MiniPill } from './mini-pill';
import { ToolsSheet } from './tools-sheet';

export const InternalTools = forwardRef<
	InternalToolsHandle,
	InternalToolsProps
>(function InternalTools(
	{
		enabled,
		visible = enabled,
		plugins,
		title = 'Developer Tools',
		launcherLabel = 'Open developer tools',
		pillLabel,
		defaultPresentationMode = 'sheet',
		presentationMode: controlledPresentationMode,
		onPresentationModeChange,
		persistence,
		bottomObstructionInset = 0,
		onError,
		onAuditEvent,
	},
	ref,
) {
	const validatedPlugins = useMemo(() => {
		assertUniquePluginIds(plugins);
		return plugins;
	}, [plugins]);
	const onErrorRef = useRef(onError);
	onErrorRef.current = onError;
	const onAuditEventRef = useRef(onAuditEvent);
	onAuditEventRef.current = onAuditEvent;
	const localStateVersionRef = useRef(0);
	const persistenceWriterRef = useRef(new SerializedPersistenceWriter());
	const markLocalStateChange = useCallback(() => {
		localStateVersionRef.current += 1;
	}, []);
	const actionServices = useMemo(
		() =>
			createActionServices({
				onError: (error, pluginId) =>
					onErrorRef.current?.(error, { kind: 'action', pluginId }),
				onAuditEvent: (event) => onAuditEventRef.current?.(event),
			}),
		[],
	);
	const controlledPresentationModeRef = useRef(controlledPresentationMode);
	controlledPresentationModeRef.current = controlledPresentationMode;
	const [isPresented, setIsPresented] = useState(false);
	const installerRegistry = useRef<PluginInstallerRegistry | null>(null);
	if (installerRegistry.current === null) {
		installerRegistry.current = new PluginInstallerRegistry();
	}
	const [selectedPluginId, setSelectedPluginId] = useState<string | null>(null);
	const [uncontrolledPresentationMode, setUncontrolledPresentationMode] =
		useState<DevToolsPresentationMode>(defaultPresentationMode);
	const presentationMode =
		controlledPresentationMode ?? uncontrolledPresentationMode;
	const [restoreMode, setRestoreMode] = useState<'sheet' | 'window'>(
		defaultPresentationMode === 'window' ? 'window' : 'sheet',
	);
	const [launcherPosition, setLauncherPosition] = useState<DevToolsPosition>();
	const [windowPosition, setWindowPosition] = useState<DevToolsPosition>();
	const [pillPosition, setPillPosition] = useState<DevToolsPosition>();
	const [hydratedPersistenceKey, setHydratedPersistenceKey] = useState<
		string | null
	>(null);
	const [hydratedPersistenceStorage, setHydratedPersistenceStorage] =
		useState<DevToolsPersistenceStorage | null>(null);
	const persistenceKey = persistence?.key ?? DEFAULT_PERSISTENCE_KEY;
	const persistenceStorage = persistence?.storage;
	const selectedPluginCandidate = validatedPlugins.find(
		(plugin) => plugin.id === selectedPluginId,
	);
	const selectedPlugin =
		selectedPluginCandidate && isPanelPlugin(selectedPluginCandidate)
			? selectedPluginCandidate
			: undefined;

	useEffect(() => {
		installerRegistry.current?.setErrorHandler((error, pluginId) => {
			onErrorRef.current?.(error, { kind: 'collector', pluginId });
		});
		installerRegistry.current?.update(enabled, validatedPlugins);
	}, [enabled, validatedPlugins]);

	useEffect(
		() => () => {
			installerRegistry.current?.dispose();
		},
		[],
	);

	useEffect(() => {
		if (!persistenceStorage) {
			setHydratedPersistenceKey(null);
			setHydratedPersistenceStorage(null);
			return;
		}
		let active = true;
		const localStateVersion = localStateVersionRef.current;
		Promise.resolve(persistenceStorage.getItem(persistenceKey)).then(
			(value) => {
				if (!active) return;
				const state = parsePersistedState(value);
				if (state && localStateVersionRef.current === localStateVersion) {
					if (controlledPresentationModeRef.current === undefined) {
						setUncontrolledPresentationMode(state.presentationMode);
					}
					setRestoreMode(state.restoreMode);
					setLauncherPosition(state.launcherPosition);
					setWindowPosition(state.windowPosition);
					setPillPosition(state.pillPosition);
				}
				setHydratedPersistenceKey(persistenceKey);
				setHydratedPersistenceStorage(persistenceStorage);
			},
			(error: unknown) => {
				if (!active) return;
				onErrorRef.current?.(error, { kind: 'persistence' });
				setHydratedPersistenceKey(persistenceKey);
				setHydratedPersistenceStorage(persistenceStorage);
			},
		);
		return () => {
			active = false;
		};
	}, [persistenceKey, persistenceStorage]);

	useEffect(() => {
		if (
			!persistenceStorage ||
			hydratedPersistenceKey !== persistenceKey ||
			hydratedPersistenceStorage !== persistenceStorage
		)
			return;
		const state = JSON.stringify({
			version: 1,
			presentationMode,
			restoreMode,
			launcherPosition,
			windowPosition,
			pillPosition,
		});
		persistenceWriterRef.current
			.write(persistenceStorage, persistenceKey, state)
			.catch((error: unknown) =>
				onErrorRef.current?.(error, { kind: 'persistence' }),
			);
	}, [
		hydratedPersistenceKey,
		hydratedPersistenceStorage,
		launcherPosition,
		persistenceKey,
		persistenceStorage,
		pillPosition,
		presentationMode,
		restoreMode,
		windowPosition,
	]);

	useEffect(() => {
		if (selectedPluginId && !selectedPluginCandidate) {
			setSelectedPluginId(null);
		}
	}, [selectedPluginCandidate, selectedPluginId]);

	const setPresentationMode = useCallback(
		(nextMode: DevToolsPresentationMode) => {
			markLocalStateChange();
			if (nextMode === 'sheet' || nextMode === 'window') {
				setRestoreMode(nextMode);
			} else if (presentationMode !== 'pill') {
				setRestoreMode(presentationMode);
			}
			if (controlledPresentationMode === undefined) {
				setUncontrolledPresentationMode(nextMode);
			}
			onPresentationModeChange?.(nextMode);
		},
		[
			controlledPresentationMode,
			markLocalStateChange,
			onPresentationModeChange,
			presentationMode,
		],
	);

	const setPersistedPosition = useCallback(
		(
			setter: (position: DevToolsPosition) => void,
			position: DevToolsPosition,
		) => {
			markLocalStateChange();
			setter(position);
		},
		[markLocalStateChange],
	);

	const close = useCallback(() => {
		setIsPresented(false);
		setSelectedPluginId(null);
	}, []);

	const open = useCallback(() => {
		if (presentationMode === 'pill') {
			setPresentationMode(restoreMode);
		}
		setIsPresented(true);
	}, [presentationMode, restoreMode, setPresentationMode]);

	const restore = useCallback(() => {
		setPresentationMode(restoreMode);
	}, [restoreMode, setPresentationMode]);

	const selectPlugin = useCallback(
		(plugin: DevToolsPlugin) => {
			if (isPanelPlugin(plugin)) {
				setSelectedPluginId(plugin.id);
				return;
			}
			void actionServices.run({
				pluginId: plugin.id,
				label: plugin.title,
				confirmation: plugin.confirmation,
				action: () =>
					plugin.onPress({
						close,
						presentationMode,
						setPresentationMode,
					}),
			});
		},
		[actionServices, close, presentationMode, setPresentationMode],
	);

	const openPlugin = useCallback(
		(pluginId: string) => {
			const plugin = validatedPlugins.find((entry) => entry.id === pluginId);
			if (!plugin) return;
			if (presentationMode === 'pill') setPresentationMode(restoreMode);
			setIsPresented(true);
			selectPlugin(plugin);
		},
		[
			presentationMode,
			restoreMode,
			selectPlugin,
			setPresentationMode,
			validatedPlugins,
		],
	);

	useImperativeHandle(
		ref,
		() => ({ open, close, openPlugin, setPresentationMode }),
		[close, open, openPlugin, setPresentationMode],
	);

	const handlePluginError = useCallback((error: unknown, pluginId: string) => {
		onErrorRef.current?.(error, { kind: 'panel', pluginId });
	}, []);

	if (!enabled || !visible) return null;

	return (
		<View pointerEvents="box-none" style={styles.overlay}>
			{isPresented ? null : (
				<FloatingLauncher
					initialPosition={launcherPosition}
					label={launcherLabel}
					onOpen={open}
					onPositionChange={(position) =>
						setPersistedPosition(setLauncherPosition, position)
					}
					bottomObstructionInset={bottomObstructionInset}
				/>
			)}
			{isPresented && presentationMode === 'sheet' ? (
				<ToolsSheet
					isPresented
					onBack={() => setSelectedPluginId(null)}
					onClose={close}
					onPresentationModeChange={setPresentationMode}
					onSelectPlugin={selectPlugin}
					plugins={validatedPlugins}
					selectedPlugin={selectedPlugin}
					title={title}
					onPluginError={handlePluginError}
					actions={actionServices}
				/>
			) : null}
			{isPresented && presentationMode === 'window' ? (
				<FloatingWindow
					initialPosition={windowPosition}
					onBack={() => setSelectedPluginId(null)}
					onClose={close}
					onPresentationModeChange={setPresentationMode}
					onSelectPlugin={selectPlugin}
					plugins={validatedPlugins}
					selectedPlugin={selectedPlugin}
					title={title}
					onPluginError={handlePluginError}
					onPositionChange={(position) =>
						setPersistedPosition(setWindowPosition, position)
					}
					actions={actionServices}
				/>
			) : null}
			{isPresented && presentationMode === 'pill' ? (
				<MiniPill
					initialPosition={pillPosition}
					label={selectedPlugin?.title ?? pillLabel ?? title}
					onClose={close}
					onRestore={restore}
					onPositionChange={(position) =>
						setPersistedPosition(setPillPosition, position)
					}
					bottomObstructionInset={bottomObstructionInset}
				/>
			) : null}
		</View>
	);
});

const styles = StyleSheet.create({
	overlay: {
		bottom: 0,
		left: 0,
		position: 'absolute',
		right: 0,
		top: 0,
		zIndex: 10_000,
	},
});
