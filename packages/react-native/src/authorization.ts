export type InternalToolsAuthorization = Readonly<{
	enabled: boolean;
	ownerId: string | null;
}>;

const DISABLED_AUTHORIZATION: InternalToolsAuthorization = Object.freeze({
	enabled: false,
	ownerId: null,
});

let snapshot = DISABLED_AUTHORIZATION;
const listeners = new Set<() => void>();

export function setInternalToolsAuthorization(
	next: InternalToolsAuthorization
): void {
	const normalized: InternalToolsAuthorization = Object.freeze({
		enabled: Boolean(next.enabled),
		ownerId: typeof next.ownerId === 'string' ? next.ownerId : null,
	});
	if (
		snapshot.enabled === normalized.enabled &&
		snapshot.ownerId === normalized.ownerId
	) {
		return;
	}
	snapshot = normalized;
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// Authorization observers are diagnostics and cannot affect the app.
		}
	}
}

export function disableInternalToolsAuthorization(): void {
	setInternalToolsAuthorization(DISABLED_AUTHORIZATION);
}

export function getInternalToolsAuthorization(): InternalToolsAuthorization {
	return snapshot;
}

export function subscribeToInternalToolsAuthorization(
	listener: () => void
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}
