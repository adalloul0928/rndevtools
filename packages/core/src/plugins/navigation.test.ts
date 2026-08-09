import { createNavigationPlugin, inferNavigationRouteKind } from './navigation';

describe('createNavigationPlugin', () => {
	it('records route changes and deduplicates identical consecutive routes', () => {
		const navigation = createNavigationPlugin();
		navigation.record('/home', { segments: ['(tabs)', 'home'] });
		navigation.record('/home', { segments: ['(tabs)', 'home'] });
		navigation.record('/profile');

		expect(navigation.getEvents().map((event) => event.route)).toEqual([
			'/home',
			'/profile',
		]);
	});

	it('stores route inventory and live stack snapshots', () => {
		const navigation = createNavigationPlugin();
		navigation.updateRoutes([
			{
				id: 'workout',
				path: '/workouts/[id]',
				kind: inferNavigationRouteKind('/workouts/[id]'),
			},
		]);
		navigation.updateStack([
			{ key: 'home', name: 'index', depth: 0, visible: true },
		]);

		expect(navigation.getRoutes()[0]?.kind).toBe('dynamic');
		expect(navigation.getStack()[0]?.visible).toBe(true);
	});

	it('records metadata changes and identifies grouped layout routes as layouts', () => {
		const navigation = createNavigationPlugin();
		navigation.record('/home', { metadata: { source: 'tab' } });
		navigation.record('/home', { metadata: { source: 'deep-link' } });

		expect(navigation.getEvents()).toHaveLength(2);
		expect(inferNavigationRouteKind('(tabs)/_layout')).toBe('layout');
	});
});
