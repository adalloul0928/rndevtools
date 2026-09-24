import { withDevtoolsPruning } from '../metro.js';

type ResolveRequest = (
	context: { originModulePath: string; resolveRequest: ResolveRequest },
	moduleName: string,
	platform: string | null,
) => { type: 'sourceFile'; filePath: string };

const projectRoot = '/app';
const stub = 'src/lib/devtools-disabled.tsx';

function resolveWith(moduleName: string, originModulePath: string): string {
	const config = withDevtoolsPruning(
		{ resolver: {} },
		{
			enabled: true,
			projectRoot,
			replace: [
				{
					module: '@/lib/devtools/host',
					path: 'src/lib/devtools/host',
					stub,
				},
			],
		},
	) as { resolver: { resolveRequest: ResolveRequest } };
	const passthrough: ResolveRequest = (_context, name) => ({
		type: 'sourceFile',
		filePath: name,
	});
	return config.resolver.resolveRequest(
		{ originModulePath, resolveRequest: passthrough },
		moduleName,
		'ios',
	).filePath;
}

const stubPath = `${projectRoot}/${stub}`;
const origin = `${projectRoot}/src/app/_layout.tsx`;

describe('withDevtoolsPruning', () => {
	it('replaces the alias specifier', () => {
		expect(resolveWith('@/lib/devtools/host', origin)).toBe(stubPath);
	});

	it('replaces the absolute path with or without an extension', () => {
		const absolute = `${projectRoot}/src/lib/devtools/host`;
		expect(resolveWith(absolute, origin)).toBe(stubPath);
		expect(resolveWith(`${absolute}.tsx`, origin)).toBe(stubPath);
	});

	it('replaces a relative specifier resolved against the importer', () => {
		// babel-plugin-module-resolver rewrites `@/…` to this before Metro sees it.
		expect(resolveWith('../lib/devtools/host', origin)).toBe(stubPath);
	});

	it('leaves unrelated relative imports alone', () => {
		expect(resolveWith('../lib/devtools/other', origin)).toBe(
			'../lib/devtools/other',
		);
	});

	it('is a no-op when disabled', () => {
		const config = withDevtoolsPruning(
			{ resolver: {} },
			{ enabled: false, projectRoot, replace: [] },
		) as { resolver: { resolveRequest?: ResolveRequest } };
		expect(config.resolver.resolveRequest).toBeUndefined();
	});
});
