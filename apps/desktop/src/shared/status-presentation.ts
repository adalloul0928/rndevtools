/** Semantic status vocabulary shared by main summaries and renderer surfaces. */
export type StatusTone = 'default' | 'success' | 'info' | 'warning' | 'danger';

export const METRO_STATUS = {
	ready: { label: 'ready', tone: 'success' },
	starting: { label: 'starting', tone: 'info' },
	stopped: { label: 'stopped', tone: 'danger' },
} as const;

export const BACKEND_STATUS = {
	ready: { label: 'Ready', tone: 'success' },
	starting: { label: 'Starting…', tone: 'info' },
	stopped: { label: 'Stopped', tone: 'warning' },
	skipped: { label: 'Skipped', tone: 'warning' },
	failed: { label: 'Failed', tone: 'danger' },
	refused: { label: 'Refused', tone: 'danger' },
	stale: { label: 'Stale branch', tone: 'warning' },
	shadowed: { label: 'Shadowed by .env', tone: 'warning' },
	blocked: { label: 'Blocked', tone: 'warning' },
} as const;
