import { assertUniquePluginIds } from '../core/plugins';
import { createEnvironmentPlugin } from './environment';
import { createNavigationPlugin } from './navigation';
import { createNetworkPlugin } from './network';
import { createQueryPlugin } from './query';
import { createStoragePlugin } from './storage';

jest.mock('@expo/ui/swift-ui', () => ({}));
jest.mock('@expo/ui/swift-ui/modifiers', () => ({}));

type MinimalQueryClient = Parameters<
	typeof createQueryPlugin
>[0]['queryClient'];

const queryClientStub = {
	getQueryCache: () => ({ getAll: () => [], subscribe: () => () => {} }),
	getMutationCache: () => ({ getAll: () => [], subscribe: () => () => {} }),
	invalidateQueries: async () => {},
	refetchQueries: async () => {},
	resetQueries: async () => {},
	removeQueries: () => {},
	clear: () => {},
} as unknown as MinimalQueryClient;

function builtInPlugins() {
	const network = createNetworkPlugin({});
	const query = createQueryPlugin({ queryClient: queryClientStub });
	const storage = createStoragePlugin({ adapters: [] });
	const navigation = createNavigationPlugin({});
	const environment = createEnvironmentPlugin({
		sections: [{ title: 'Application', values: { APP: 'pumpd' } }],
	});
	return [
		network.plugin,
		query,
		storage.plugin,
		navigation.plugin,
		environment,
	];
}

describe('built-in diagnostic panels', () => {
	it('produce renderable panel plugins with unique ids', () => {
		const plugins = builtInPlugins();
		expect(() => assertUniquePluginIds(plugins)).not.toThrow();
		for (const plugin of plugins) {
			expect(plugin.id).toBeTruthy();
			expect(plugin.title).toBeTruthy();
			expect(plugin.systemImage).toBeTruthy();
			expect(typeof plugin.Panel).toBe('function');
		}
	});

	it('keeps stable ids the host and persistence rely on', () => {
		const ids = builtInPlugins().map((plugin) => plugin.id);
		expect(ids).toEqual([
			'network',
			'queries',
			'storage',
			'navigation',
			'environment',
		]);
	});

	it('titles the navigation panel as Screens', () => {
		const navigation = createNavigationPlugin({});
		expect(navigation.plugin.title).toBe('Screens');
	});
});
