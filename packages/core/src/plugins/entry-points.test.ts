jest.mock('./images', () => {
	throw new Error(
		'The shared plugins entry point must not load image diagnostics',
	);
});

jest.mock('./storage', () => {
	throw new Error(
		'The shared plugins entry point must not load the storage editor',
	);
});

it('loads production staff plugin factories without development-only plugins', () => {
	const plugins = jest.requireActual<typeof import('./index')>(
		'@pumpd/devtools/plugins',
	);

	expect(plugins).toEqual(
		expect.objectContaining({
			createLazyCustomPlugin: expect.any(Function),
			createNetworkPlugin: expect.any(Function),
			createQueryPlugin: expect.any(Function),
		}),
	);
});
