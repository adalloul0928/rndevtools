import {
	createEnvironmentPlugin,
	validateEnvironmentValues,
} from './environment';

describe('validateEnvironmentValues', () => {
	it('reports valid, missing, type, and value checks', () => {
		const sections = [
			{
				title: 'App',
				values: { NAME: 'PUMPD', COUNT: '2', PLATFORM: 'android' },
			},
		];
		const results = validateEnvironmentValues(sections, [
			{ key: 'NAME', section: 'App', expectedType: 'string' },
			{ key: 'MISSING', section: 'App', required: true },
			{ key: 'COUNT', section: 'App', expectedType: 'number' },
			{ key: 'PLATFORM', section: 'App', expectedValue: 'ios' },
			{ key: 'OPTIONAL', section: 'App', required: false },
		]);

		expect(results.map((result) => result.status)).toEqual([
			'valid',
			'missing',
			'typeMismatch',
			'valueMismatch',
			'valid',
		]);
	});

	it('rejects duplicate section names and compares object values structurally', () => {
		expect(() =>
			createEnvironmentPlugin({
				sections: [
					{ title: 'Build', values: {} },
					{ title: 'Build', values: {} },
				],
			}),
		).toThrow('Duplicate environment section title');
		const [result] = validateEnvironmentValues(
			[{ title: 'Build', values: { config: { a: 1, b: 2 } } }],
			[{ key: 'config', expectedValue: { b: 2, a: 1 } }],
		);
		expect(result?.status).toBe('valid');
	});
});
