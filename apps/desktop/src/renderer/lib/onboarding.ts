import { useSyncExternalStore } from 'react';

const SETUP_KEY = 'rndevtools.desktop.onboarding.setup';
const CHECKLIST_KEY = 'rndevtools.desktop.onboarding.checklist';
const COMPLETED_KEY = 'rndevtools.desktop.onboarding.completed';
/** More than the checklist has tasks, so a stored list is never cut short. */
const MAX_COMPLETED_TASKS = 32;
const TASK_ID = /^[a-z][a-z-]{0,47}$/;

export const SETUP_STEPS = [
	'welcome',
	'mac',
	'project',
	'app',
	'extras',
	'ready',
] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

export type OnboardingSnapshot = Readonly<{
	/** The setup window and the step it shows. */
	setup: Readonly<{ open: boolean; step: SetupStep }>;
	/** Setup was finished or closed, so it no longer opens by itself. */
	setupDone: boolean;
	/** The Get started checklist was hidden from the sidebar. */
	checklistHidden: boolean;
	/**
	 * Get started tasks finished at least once. The checklist reads live state,
	 * so without this a shut-down Simulator or a disconnected app would undo a
	 * tick after a relaunch.
	 */
	completedTasks: readonly string[];
}>;

function read(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string | null): void {
	try {
		if (value === null) window.localStorage.removeItem(key);
		else window.localStorage.setItem(key, value);
	} catch {
		// Onboarding preferences are best-effort; setup still works without them.
	}
}

/** The stored task ids, or none when the value is missing or not ours. */
export function parseCompletedTasks(raw: string | null): readonly string[] {
	if (raw === null || raw.length > 4_096) return [];
	try {
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) return [];
		const ids = value.filter(
			(id): id is string => typeof id === 'string' && TASK_ID.test(id)
		);
		return [...new Set(ids)].slice(0, MAX_COMPLETED_TASKS);
	} catch {
		return [];
	}
}

let snapshot: OnboardingSnapshot = {
	setup: { open: false, step: 'welcome' },
	setupDone: read(SETUP_KEY) === 'done',
	checklistHidden: read(CHECKLIST_KEY) === 'hidden',
	completedTasks: parseCompletedTasks(read(COMPLETED_KEY)),
};
const listeners = new Set<() => void>();

function publish(next: Partial<OnboardingSnapshot>): void {
	snapshot = { ...snapshot, ...next };
	for (const listener of listeners) listener();
}

export function openSetup(step: SetupStep = 'welcome'): void {
	publish({ setup: { open: true, step } });
}

export function setSetupStep(step: SetupStep): void {
	publish({ setup: { ...snapshot.setup, step } });
}

/** Closing setup, finished or not, keeps it from opening by itself again. */
export function closeSetup(): void {
	write(SETUP_KEY, 'done');
	publish({ setup: { ...snapshot.setup, open: false }, setupDone: true });
}

export function setChecklistHidden(hidden: boolean): void {
	write(CHECKLIST_KEY, hidden ? 'hidden' : null);
	publish({ checklistHidden: hidden });
}

/** Remembers tasks as finished; a task once done stays done. */
export function rememberCompletedTasks(ids: readonly string[]): void {
	const known = new Set(snapshot.completedTasks);
	const added = ids.filter((id) => TASK_ID.test(id) && !known.has(id));
	if (added.length === 0) return;
	const completedTasks = [...snapshot.completedTasks, ...added].slice(
		0,
		MAX_COMPLETED_TASKS
	);
	write(COMPLETED_KEY, JSON.stringify(completedTasks));
	publish({ completedTasks });
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useOnboarding(): OnboardingSnapshot {
	const read = () => snapshot;
	return useSyncExternalStore(subscribe, read, read);
}

/**
 * Whether first-run setup should open by itself: for someone who has no
 * repository or lane yet and never closed setup. Callers decide only once the
 * lane state has really been read; a failed read leaves an empty state that
 * must not pass for an empty workspace.
 */
export function shouldOpenSetup(input: {
	setupDone: boolean;
	repositories: number;
	lanes: number;
}): boolean {
	return !input.setupDone && input.repositories === 0 && input.lanes === 0;
}

/**
 * The line a setup step shows after one of its actions ran: nothing when it
 * completed or the person cancelled a picker, the error otherwise. Setup is a
 * modal, so a result left to the app's toast would not be seen or announced.
 */
export function setupActionError(
	receipt:
		| Readonly<{
				completed: boolean;
				cancelled?: boolean | undefined;
				error?: string | undefined;
		  }>
		| undefined,
	fallback: string
): string | null {
	if (receipt === undefined) return fallback;
	if (receipt.completed || receipt.cancelled) return null;
	return receipt.error ?? fallback;
}

/** The step before or after, or the same step at either end. */
export function adjacentSetupStep(step: SetupStep, offset: -1 | 1): SetupStep {
	const index = SETUP_STEPS.indexOf(step) + offset;
	return (
		SETUP_STEPS[Math.min(Math.max(index, 0), SETUP_STEPS.length - 1)] ?? step
	);
}
