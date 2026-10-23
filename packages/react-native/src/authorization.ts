export type DevtoolsAuthorization = Readonly<{
	enabled: boolean;
	ownerId: string | null;
}>;

type OwnerSource = Readonly<{
	getOwnerId: () => string | null;
	subscribe: (listener: () => void) => () => void;
}>;

type OwnerBoundary = {
	readonly source: OwnerSource;
	observable: boolean;
	cleanup: (() => void) | undefined;
};

/** Production-bundle marker; keep it in an observable error so minifiers retain it. */
const AUTHORIZATION_MODULE = '@rndevtools/react-native/authorization';

const DISABLED_AUTHORIZATION: DevtoolsAuthorization = Object.freeze({
	enabled: false,
	ownerId: null,
});

let snapshot = DISABLED_AUTHORIZATION;
const listeners = new Set<() => void>();
let ownerBoundary: OwnerBoundary | undefined;

function publish(next: DevtoolsAuthorization): void {
	if (snapshot.enabled === next.enabled && snapshot.ownerId === next.ownerId) {
		return;
	}
	snapshot = next;
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			// Authorization observers are diagnostics and cannot affect the app.
		}
	}
}

function isLiveOwner(boundary: OwnerBoundary, ownerId: string | null): boolean {
	// A source that cannot report owner changes could never revoke this grant.
	if (!boundary.observable) return false;
	try {
		const candidate = boundary.source.getOwnerId();
		return (typeof candidate === 'string' ? candidate : null) === ownerId;
	} catch {
		// A failed owner read is a revocation boundary.
		return false;
	}
}

function reconcileOwnerBoundary(boundary: OwnerBoundary): void {
	// A re-bind retires the previous source, so its late notifications are inert.
	if (ownerBoundary !== boundary || !snapshot.enabled) return;
	if (!isLiveOwner(boundary, snapshot.ownerId)) {
		publish(DISABLED_AUTHORIZATION);
	}
}

/** Only the bound source's live owner may receive a grant. Missing authorization revokes, then throws. */
export function setDevtoolsAuthorization(next: DevtoolsAuthorization): void {
	if (next == null) {
		// A grant that failed to compute must not leave an earlier one in force.
		publish(DISABLED_AUTHORIZATION);
		throw new TypeError(
			`${AUTHORIZATION_MODULE}: setDevtoolsAuthorization needs { enabled, ownerId }.`,
		);
	}
	const normalized: DevtoolsAuthorization = Object.freeze({
		enabled: Boolean(next.enabled),
		ownerId: typeof next.ownerId === 'string' ? next.ownerId : null,
	});
	const boundary = ownerBoundary;
	if (
		normalized.enabled &&
		boundary &&
		!isLiveOwner(boundary, normalized.ownerId)
	) {
		// Refusing a stale grant may only revoke, never keep a grant stale too.
		reconcileOwnerBoundary(boundary);
		return;
	}
	publish(normalized);
}

export function disableDevtoolsAuthorization(): void {
	publish(DISABLED_AUTHORIZATION);
}

export function getDevtoolsAuthorization(): DevtoolsAuthorization {
	return snapshot;
}

export function subscribeToDevtoolsAuthorization(
	listener: () => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Owner changes revoke synchronously; the host must explicitly re-grant.
 * Failed subscriptions block grants until a working source is bound.
 */
export function bindDevtoolsAuthorizationOwnerSource(
	source: OwnerSource,
): void {
	const previous = ownerBoundary;
	const boundary: OwnerBoundary = {
		source,
		observable: true,
		cleanup: undefined,
	};
	ownerBoundary = boundary;
	try {
		previous?.cleanup?.();
	} catch {
		// The retired source's listener is already inert.
	}
	try {
		const cleanup = source.subscribe(() => reconcileOwnerBoundary(boundary));
		boundary.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
	} catch {
		boundary.observable = false;
	}
	reconcileOwnerBoundary(boundary);
}
