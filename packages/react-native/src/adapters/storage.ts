import type { DevToolsStorageAdapter } from '@rndevtools/core/plugins/storage';

export type AsyncStorageLike = {
	getAllKeys: () => Promise<readonly string[]>;
	getItem: (key: string) => Promise<string | null>;
	setItem: (key: string, value: string) => Promise<void>;
	removeItem: (key: string) => Promise<void>;
	clear: () => Promise<void>;
};

export function createAsyncStorageDevtoolsAdapter(
	storage: AsyncStorageLike,
): DevToolsStorageAdapter {
	return {
		id: 'example-async-storage',
		title: 'AsyncStorage',
		description: 'React Native asynchronous key-value storage',
		capabilities: {
			enumerable: true,
			readable: true,
			writable: true,
			deletable: true,
			clearable: true,
			sensitive: false,
			requiresAuthentication: false,
		},
		getAllKeys: () => storage.getAllKeys(),
		getValue: (key) => storage.getItem(key),
		setValue: (key, value) => storage.setItem(key, String(value)),
		parseValue: (_key, draft) => draft,
		removeValue: (key) => storage.removeItem(key),
		clear: () => storage.clear(),
	};
}

export type SecureStoreManifestEntry = Readonly<{
	key: string;
	description: string;
	requiresAuthentication?: boolean;
	revealable?: boolean;
	options?: Readonly<Record<string, unknown>>;
}>;

export type SecureStoreLike = {
	getItemAsync: (
		key: string,
		options?: Readonly<Record<string, unknown>>,
	) => Promise<string | null>;
};

export function createSecureStoreDevtoolsAdapter(
	storage: SecureStoreLike,
	manifest: readonly SecureStoreManifestEntry[],
): DevToolsStorageAdapter {
	const entries = new Map(manifest.map((entry) => [entry.key, entry]));
	return {
		id: 'example-secure-store',
		title: 'SecureStore',
		description:
			'Explicitly registered keychain metadata; values stay on device',
		capabilities: {
			enumerable: false,
			readable: true,
			writable: false,
			deletable: false,
			clearable: false,
			sensitive: true,
			requiresAuthentication: false,
		},
		registeredKeys: manifest.map(
			({ key, description, requiresAuthentication, revealable }) => ({
				key,
				description,
				...(requiresAuthentication ? { requiresAuthentication: true } : {}),
				...(revealable ? { revealable: true } : {}),
			}),
		),
		revealValue: async (key) => {
			const entry = entries.get(key);
			if (!entry) throw new Error('SecureStore key is not registered.');
			if (entry.revealable !== true) {
				throw new Error('SecureStore key is metadata-only.');
			}
			return storage.getItemAsync(key, entry.options);
		},
	};
}
