import type { Mutation, Query, QueryKey } from '@tanstack/react-query';
import { serializeValue } from '../core/serialize';

export type QuerySnapshot = {
	hash: string;
	queryKey: QueryKey;
	key: string;
	status: string;
	fetchStatus: string;
	observerCount: number;
	isStale: boolean;
	dataUpdatedAt: number;
	errorUpdatedAt: number;
	dataUpdateCount: number;
	fetchFailureCount: number;
	data?: string;
	error?: string;
	truncated: boolean;
};

export type MutationSnapshot = {
	id: number;
	mutationKey?: QueryKey;
	key: string;
	status: string;
	submittedAt: number;
	failureCount: number;
	isPaused: boolean;
	variables?: string;
	data?: string;
	error?: string;
	truncated: boolean;
};

export type QueryPluginSnapshot = {
	queries: readonly QuerySnapshot[];
	mutations: readonly MutationSnapshot[];
};

export function createQuerySnapshot(
	query: Query,
	captureData: boolean,
	maxSnapshotBytes: number,
): QuerySnapshot {
	const key = serializeValue(query.queryKey, 16 * 1024);
	const data = captureData
		? serializeValue(query.state.data, maxSnapshotBytes)
		: undefined;
	const error = query.state.error
		? serializeValue(query.state.error, maxSnapshotBytes)
		: undefined;
	return {
		hash: query.queryHash,
		queryKey: query.queryKey,
		key: key.text,
		status: query.state.status,
		fetchStatus: query.state.fetchStatus,
		observerCount: query.getObserversCount(),
		isStale: query.isStale(),
		dataUpdatedAt: query.state.dataUpdatedAt,
		errorUpdatedAt: query.state.errorUpdatedAt,
		dataUpdateCount: query.state.dataUpdateCount,
		fetchFailureCount: query.state.fetchFailureCount,
		data: data?.text,
		error: error?.text,
		truncated: key.truncated || !!data?.truncated || !!error?.truncated,
	};
}

export function createMutationSnapshot<TData, TError, TVariables, TContext>(
	mutation: Mutation<TData, TError, TVariables, TContext>,
	captureData: boolean,
	maxSnapshotBytes: number,
): MutationSnapshot {
	const key = serializeValue(
		mutation.options.mutationKey ?? ['anonymous mutation'],
		16 * 1024,
	);
	const variables = captureData
		? serializeValue(mutation.state.variables, maxSnapshotBytes)
		: undefined;
	const data = captureData
		? serializeValue(mutation.state.data, maxSnapshotBytes)
		: undefined;
	const error = mutation.state.error
		? serializeValue(mutation.state.error, maxSnapshotBytes)
		: undefined;
	return {
		id: mutation.mutationId,
		mutationKey: mutation.options.mutationKey,
		key: key.text,
		status: mutation.state.status,
		submittedAt: mutation.state.submittedAt,
		failureCount: mutation.state.failureCount,
		isPaused: mutation.state.isPaused,
		variables: variables?.text,
		data: data?.text,
		error: error?.text,
		truncated:
			key.truncated ||
			!!variables?.truncated ||
			!!data?.truncated ||
			!!error?.truncated,
	};
}

export function limitQuerySnapshotsByBytes<
	T extends QuerySnapshot | MutationSnapshot,
>(values: readonly T[], budget: number): readonly T[] {
	const retained: T[] = [];
	let usedBytes = 0;
	for (const value of values) {
		const estimatedBytes = serializeValue(
			{ ...value, queryKey: undefined, mutationKey: undefined },
			Number.MAX_SAFE_INTEGER,
		).estimatedBytes;
		if (usedBytes + estimatedBytes > budget) continue;
		retained.push(value);
		usedBytes += estimatedBytes;
	}
	return retained;
}
