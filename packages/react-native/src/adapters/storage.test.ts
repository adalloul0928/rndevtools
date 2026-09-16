import {
	createAsyncStorageDevtoolsAdapter,
	createSecureStoreDevtoolsAdapter,
} from './storage';

describe('storage diagnostic adapters', () => {
	it('maps AsyncStorage through the enumerable writable contract', async () => {
		const storage = {
			getAllKeys: jest.fn(async () => ['theme']),
			getItem: jest.fn(async () => 'dark'),
			setItem: jest.fn(async () => undefined),
			removeItem: jest.fn(async () => undefined),
			clear: jest.fn(async () => undefined),
		};
		const adapter = createAsyncStorageDevtoolsAdapter(storage);

		expect(adapter.capabilities).toMatchObject({
			enumerable: true,
			readable: true,
			writable: true,
		});
		expect(await adapter.getAllKeys?.()).toEqual(['theme']);
		expect(await adapter.getValue?.('theme')).toBe('dark');
		await adapter.setValue?.('theme', 42);
		expect(storage.setItem).toHaveBeenCalledWith('theme', '42');
	});

	it('lists SecureStore manifest metadata without reading until explicit reveal', async () => {
		const getItemAsync = jest.fn(async () => 'protected-value');
		const adapter = createSecureStoreDevtoolsAdapter({ getItemAsync }, [
			{
				key: 'biometric-token',
				description: 'Biometric credential',
				requiresAuthentication: true,
				revealable: true,
				options: { requireAuthentication: true },
			},
		]);

		expect(adapter.capabilities).toMatchObject({
			enumerable: false,
			sensitive: true,
		});
		expect(adapter.registeredKeys).toEqual([
			{
				key: 'biometric-token',
				description: 'Biometric credential',
				requiresAuthentication: true,
				revealable: true,
			},
		]);
		expect(getItemAsync).not.toHaveBeenCalled();
		expect(await adapter.revealValue?.('biometric-token')).toBe(
			'protected-value',
		);
		expect(getItemAsync).toHaveBeenCalledWith('biometric-token', {
			requireAuthentication: true,
		});
	});

	it('keeps registered encryption material metadata-only', async () => {
		const getItemAsync = jest.fn(async () => 'encryption-secret');
		const adapter = createSecureStoreDevtoolsAdapter({ getItemAsync }, [
			{
				key: 'pumpd-mmkv-encryption-key',
				description: 'Encryption material',
			},
		]);

		expect(adapter.registeredKeys).toEqual([
			{
				key: 'pumpd-mmkv-encryption-key',
				description: 'Encryption material',
			},
		]);
		await expect(
			adapter.revealValue?.('pumpd-mmkv-encryption-key'),
		).rejects.toThrow('metadata-only');
		expect(getItemAsync).not.toHaveBeenCalled();
	});

	it('rejects reveal attempts for undeclared secure keys', async () => {
		const adapter = createSecureStoreDevtoolsAdapter(
			{ getItemAsync: jest.fn(async () => null) },
			[],
		);
		await expect(adapter.revealValue?.('unknown')).rejects.toThrow(
			'not registered',
		);
	});
});
