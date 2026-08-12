import type {
	DevToolsPosition,
	DevToolsPresentationMode,
	DevToolsSize,
} from '../types';

export const DEFAULT_PERSISTENCE_KEY = '@pumpd/devtools/runtime-state';

export type DevToolsPersistedState = {
	version: 1;
	presentationMode: DevToolsPresentationMode;
	restoreMode: 'sheet' | 'window';
	launcherPosition?: DevToolsPosition;
	windowPosition?: DevToolsPosition;
	windowSize?: DevToolsSize;
	pillPosition?: DevToolsPosition;
	pinnedPillQuickActionIds?: readonly string[];
};

function isPosition(value: unknown): value is DevToolsPosition {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<DevToolsPosition>;
	return Number.isFinite(candidate.x) && Number.isFinite(candidate.y);
}

function isSize(value: unknown): value is DevToolsSize {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<DevToolsSize>;
	return (
		Number.isFinite(candidate.width) &&
		Number.isFinite(candidate.height) &&
		(candidate.width ?? 0) > 0 &&
		(candidate.height ?? 0) > 0
	);
}

function isPresentationMode(value: unknown): value is DevToolsPresentationMode {
	return value === 'sheet' || value === 'window' || value === 'pill';
}

function parsePinnedIds(value: unknown): readonly string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const ids = value.filter(
		(entry): entry is string =>
			typeof entry === 'string' && entry.trim() !== '',
	);
	return [...new Set(ids)];
}

export function parsePersistedState(
	value: string | null,
): DevToolsPersistedState | null {
	if (!value) return null;
	try {
		const candidate = JSON.parse(value) as Partial<DevToolsPersistedState>;
		const pinnedPillQuickActionIds = parsePinnedIds(
			candidate.pinnedPillQuickActionIds,
		);
		if (
			candidate.version !== 1 ||
			!isPresentationMode(candidate.presentationMode) ||
			(candidate.restoreMode !== 'sheet' && candidate.restoreMode !== 'window')
		) {
			return null;
		}

		return {
			version: 1,
			presentationMode: candidate.presentationMode,
			restoreMode: candidate.restoreMode,
			...(isPosition(candidate.launcherPosition)
				? { launcherPosition: candidate.launcherPosition }
				: {}),
			...(isPosition(candidate.windowPosition)
				? { windowPosition: candidate.windowPosition }
				: {}),
			...(isSize(candidate.windowSize)
				? { windowSize: candidate.windowSize }
				: {}),
			...(isPosition(candidate.pillPosition)
				? { pillPosition: candidate.pillPosition }
				: {}),
			...(pinnedPillQuickActionIds ? { pinnedPillQuickActionIds } : {}),
		};
	} catch {
		return null;
	}
}

export class SerializedPersistenceWriter {
	#chain: Promise<void> = Promise.resolve();

	write(
		storage: { setItem: (key: string, value: string) => void | Promise<void> },
		key: string,
		value: string,
	): Promise<void> {
		const next = this.#chain.then(() => storage.setItem(key, value));
		this.#chain = next.catch(() => undefined);
		return next;
	}
}
