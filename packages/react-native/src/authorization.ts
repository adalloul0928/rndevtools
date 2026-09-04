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
let ownerBoundaryCleanup: (() => void) | undefined;

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

/**
 * Binds the authorization mirror to its live authentication owner. A source
 * change can only revoke synchronously; React may explicitly re-grant the new
 * owner after recomputing all visibility policy.
 */
export function bindInternalToolsAuthorizationOwnerSource(source: {
	getOwnerId: () => string | null;
	subscribe: (listener: () => void) => () => void;
}): void {
	ownerBoundaryCleanup?.();
	const reconcile = () => {
		let liveOwnerId: string | null = null;
		try {
			const candidate = source.getOwnerId();
			liveOwnerId = typeof candidate === 'string' ? candidate : null;
		} catch {
			// A failed owner read is a revocation boundary.
		}
		if (snapshot.enabled && snapshot.ownerId !== liveOwnerId) {
			disableInternalToolsAuthorization();
		}
	};
	try {
		ownerBoundaryCleanup = source.subscribe(reconcile);
	} catch {
		ownerBoundaryCleanup = undefined;
	}
	reconcile();
}
