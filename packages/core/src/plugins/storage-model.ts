import { serializeValue, truncateText } from '../core/serialize';

export type DevToolsStorageAdapter = {
	id: string;
	title: string;
	description?: string;
	sensitive?: boolean;
	revealValues?: boolean;
	getAllKeys: () => readonly string[] | Promise<readonly string[]>;
	getValue?: (key: string) => unknown | Promise<unknown>;
	setValue?: (key: string, value: unknown) => void | Promise<void>;
	parseValue?: (key: string, draft: string, valueType: string) => unknown;
	removeValue?: (key: string) => void | Promise<void>;
	clear?: () => void | Promise<void>;
	subscribe?: (listener: () => void) => () => void;
};

export type StorageEntrySnapshot = {
	key: string;
	value?: string;
	valueType?: string;
	truncated: boolean;
	valueHidden: boolean;
	readError?: string;
	binary: boolean;
};

export type StorageAdapterSnapshot = {
	id: string;
	title: string;
	description?: string;
	sensitive: boolean;
	entries: readonly StorageEntrySnapshot[];
	error?: string;
};

export type StorageSnapshot = {
	loading: boolean;
	adapters: readonly StorageAdapterSnapshot[];
};

export type StorageKeyRule = {
	adapterId: string;
	key: string;
	description?: string;
	required?: boolean;
	expectedType?: 'string' | 'number' | 'boolean' | 'object' | 'array';
};

export type StorageValidationResult = StorageKeyRule & {
	status: 'valid' | 'missing' | 'typeMismatch' | 'protected';
	actualType?: string;
};

export type StorageChangeEvent = {
	id: number;
	at: number;
	adapterId: string;
	adapterTitle: string;
	key: string;
	type: 'added' | 'updated' | 'removed';
	previousValue?: string;
	value?: string;
	valueHidden: boolean;
};

function storageValueType(value: unknown): string {
	if (Array.isArray(value)) return 'array';
	if (value === null) return 'null';
	return typeof value;
}

function isBinaryStorageValue(value: unknown): boolean {
	return (
		(typeof ArrayBuffer !== 'undefined' &&
			(value instanceof ArrayBuffer || ArrayBuffer.isView(value))) ||
		(typeof Blob !== 'undefined' && value instanceof Blob)
	);
}

export function parseStorageDraft(draft: string, valueType: string): unknown {
	switch (valueType) {
		case 'string':
			return draft;
		case 'number': {
			const value = Number(draft);
			if (!Number.isFinite(value)) throw new Error('Enter a finite number.');
			return value;
		}
		case 'boolean':
			if (draft === 'true') return true;
			if (draft === 'false') return false;
			throw new Error('Enter true or false.');
		case 'object': {
			const value: unknown = JSON.parse(draft);
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new Error('Enter a JSON object.');
			}
			return value;
		}
		case 'array': {
			const value: unknown = JSON.parse(draft);
			if (!Array.isArray(value)) throw new Error('Enter a JSON array.');
			return value;
		}
		default:
			throw new Error(
				`${valueType || 'Unknown'} values cannot be edited safely.`,
			);
	}
}

function isEditableValueType(valueType: string | undefined): boolean {
	return (
		valueType === 'string' ||
		valueType === 'number' ||
		valueType === 'boolean' ||
		valueType === 'object' ||
		valueType === 'array'
	);
}

export function isStorageEntryEditable(
	adapter: DevToolsStorageAdapter,
	entry: StorageEntrySnapshot,
): boolean {
	return (
		!entry.valueHidden &&
		!entry.truncated &&
		!entry.readError &&
		!entry.binary &&
		isEditableValueType(entry.valueType) &&
		!!adapter.setValue
	);
}

export function validateStorageSnapshot(
	snapshot: StorageSnapshot,
	rules: readonly StorageKeyRule[],
): readonly StorageValidationResult[] {
	return rules.map((rule) => {
		const adapter = snapshot.adapters.find(
			(candidate) => candidate.id === rule.adapterId,
		);
		const entry = adapter?.entries.find(
			(candidate) => candidate.key === rule.key,
		);
		if (!entry) {
			return { ...rule, status: rule.required === false ? 'valid' : 'missing' };
		}
		if (entry.valueHidden) return { ...rule, status: 'protected' };
		if (rule.expectedType && entry.valueType !== rule.expectedType) {
			return { ...rule, status: 'typeMismatch', actualType: entry.valueType };
		}
		return { ...rule, status: 'valid', actualType: entry.valueType };
	});
}

export async function snapshotStorageAdapter(
	adapter: DevToolsStorageAdapter,
	maxValueBytes: number,
): Promise<StorageAdapterSnapshot> {
	try {
		const keys = [...(await adapter.getAllKeys())].sort((left, right) =>
			left.localeCompare(right),
		);
		const valueHidden =
			adapter.sensitive === true && adapter.revealValues !== true;
		const entries = await Promise.all(
			keys.map(async (key): Promise<StorageEntrySnapshot> => {
				if (valueHidden || !adapter.getValue) {
					return { key, truncated: false, valueHidden: true, binary: false };
				}
				try {
					const value = await adapter.getValue(key);
					const binary = isBinaryStorageValue(value);
					const serialized = binary
						? truncateText('[Binary value omitted]', maxValueBytes)
						: typeof value === 'string'
							? truncateText(value, maxValueBytes)
							: serializeValue(value, maxValueBytes);
					return {
						key,
						value: serialized.text,
						valueType: storageValueType(value),
						truncated: serialized.truncated,
						valueHidden: false,
						binary,
					};
				} catch (error) {
					return {
						key,
						value: '[Read failed]',
						truncated: false,
						valueHidden: false,
						binary: false,
						readError: error instanceof Error ? error.message : String(error),
					};
				}
			}),
		);
		return {
			id: adapter.id,
			title: adapter.title,
			description: adapter.description,
			sensitive: adapter.sensitive ?? false,
			entries,
		};
	} catch (error) {
		return {
			id: adapter.id,
			title: adapter.title,
			description: adapter.description,
			sensitive: adapter.sensitive ?? false,
			entries: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
