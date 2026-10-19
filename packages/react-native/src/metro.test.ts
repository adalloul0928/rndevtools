import { withDevtoolsPruning } from '../metro.js';

/**
 * Pruning checks real files, so each test builds a small project on disk.
 * Node's modules are reached through a typed `require` rather than adding
 * @types/node to a React Native package.
 */
declare const require: (id: string) => unknown;

type Fs = {
	mkdtempSync: (prefix: string) => string;
	mkdirSync: (p: string, options?: { recursive?: boolean }) => void;
	rmSync: (
		p: string,
		options?: { recursive?: boolean; force?: boolean },
	) => void;
	realpathSync: (p: string) => string;
	statSync: (p: string) => { isFile: () => boolean };
	symlinkSync: (target: string, p: string) => void;
	writeFileSync: (p: string, data: string) => void;
};
type Path = {
	dirname: (p: string) => string;
	join: (...parts: string[]) => string;
	relative: (from: string, to: string) => string;
	resolve: (...parts: string[]) => string;
};
type Os = { tmpdir: () => string };
type Resolution = { type: 'sourceFile'; filePath: string };
type ResolveRequest = (
	context: { originModulePath: string; resolveRequest: ResolveRequest },
	moduleName: string,
	platform: string | null,
) => Resolution;
type ReplaceEntry = { module: string; path?: string; stub: string };

const fs = require('node:fs') as Fs;
const os = require('node:os') as Os;
const path = require('node:path') as Path;

const stub = 'src/lib/devtools-disabled.tsx';
let projectRoot: string;

function write(file: string, contents = 'export {};\n'): void {
	const absolute = path.join(projectRoot, file);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, contents);
}

function isFile(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isFile();
	} catch {
		return false;
	}
}

/**
 * Resolves the way Metro does for these fixtures: `@/` is the project's
 * `src`, bare names are packages, and a path may omit its extension or name
 * a directory index.
 */
const metroLike: ResolveRequest = (context, moduleName) => {
	const base = moduleName.startsWith('@/')
		? path.join(projectRoot, 'src', moduleName.slice(2))
		: moduleName.startsWith('.')
			? path.resolve(path.dirname(context.originModulePath), moduleName)
			: moduleName.startsWith('/')
				? moduleName
				: path.join(projectRoot, 'node_modules', moduleName);
	const extensions = ['.ts', '.tsx', '.js'];
	const filePath = [
		base,
		...extensions.map((extension) => `${base}${extension}`),
		...extensions.map((extension) => path.join(base, `index${extension}`)),
	].find(isFile);
	if (!filePath) throw new Error(`Unable to resolve ${moduleName}`);
	return { type: 'sourceFile', filePath };
};

function pruning(
	replace: readonly ReplaceEntry[],
	previous?: ResolveRequest,
): ResolveRequest {
	const config = withDevtoolsPruning(
		{ resolver: previous ? { resolveRequest: previous } : {} },
		{ enabled: true, projectRoot, replace },
	) as { resolver: { resolveRequest: ResolveRequest } };
	return config.resolver.resolveRequest;
}

/** Project-relative file that `moduleName` ends up as when imported from `origin`. */
function resolveWith(
	resolve: ResolveRequest,
	moduleName: string,
	origin = 'src/app/_layout.tsx',
): string {
	const resolution = resolve(
		{
			originModulePath: path.join(projectRoot, origin),
			resolveRequest: metroLike,
		},
		moduleName,
		'ios',
	);
	return path.relative(projectRoot, fs.realpathSync(resolution.filePath));
}

const host = {
	module: '@/lib/devtools/host',
	path: 'src/lib/devtools/host',
	stub,
};

beforeEach(() => {
	// Real, as Metro reports importers; the symlink test adds a linked root.
	projectRoot = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'rndevtools-metro-')),
	);
	write('src/app/_layout.tsx');
	write('src/lib/devtools/host.ts', 'export const host = "real";\n');
	write('src/lib/devtools/other.ts');
	write(stub, 'export const host = "stub";\n');
});

afterEach(() => {
	fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe('withDevtoolsPruning', () => {
	it('replaces the alias specifier', () => {
		expect(resolveWith(pruning([host]), '@/lib/devtools/host')).toBe(stub);
	});

	it('replaces the absolute path with or without an extension', () => {
		const resolve = pruning([host]);
		const absolute = path.join(projectRoot, 'src/lib/devtools/host');
		expect(resolveWith(resolve, absolute)).toBe(stub);
		expect(resolveWith(resolve, `${absolute}.ts`)).toBe(stub);
	});

	it('replaces a relative specifier resolved against the importer', () => {
		// babel-plugin-module-resolver rewrites `@/…` to this before Metro sees it.
		expect(resolveWith(pruning([host]), '../lib/devtools/host')).toBe(stub);
	});

	it('replaces every import of a path written with its extension', () => {
		const resolve = pruning([{ ...host, path: 'src/lib/devtools/host.ts' }]);
		expect(resolveWith(resolve, '../lib/devtools/host')).toBe(stub);
		expect(resolveWith(resolve, './host', 'src/lib/devtools/other.ts')).toBe(
			stub,
		);
	});

	it('replaces /index imports of a directory module and explicit .js imports', () => {
		write('src/devtools/panel/index.ts');
		write('src/devtools/legacy.js');
		const resolve = pruning([
			{ module: '@/devtools/panel', path: 'src/devtools/panel', stub },
			{ module: '@/devtools/legacy', path: 'src/devtools/legacy', stub },
		]);
		expect(resolveWith(resolve, '../devtools/panel/index')).toBe(stub);
		expect(resolveWith(resolve, '@/devtools/panel/index')).toBe(stub);
		expect(resolveWith(resolve, '../devtools/legacy.js')).toBe(stub);
	});

	it('checks what an earlier resolver returns', () => {
		const target = path.join(projectRoot, 'src/lib/devtools/host.ts');
		const previous: ResolveRequest = (context, moduleName, platform) =>
			moduleName === '~devtools'
				? { type: 'sourceFile', filePath: target }
				: context.resolveRequest(context, moduleName, platform);
		expect(resolveWith(pruning([host], previous), '~devtools')).toBe(stub);
	});

	it('replaces an installed package named without a path', () => {
		write(
			'node_modules/example-devtools/package.json',
			'{"name":"example-devtools","main":"index.js"}',
		);
		write('node_modules/example-devtools/index.js');
		const resolve = pruning([{ module: 'example-devtools', stub }]);
		expect(resolveWith(resolve, 'example-devtools')).toBe(stub);
		expect(resolveWith(resolve, 'example-devtools/index')).toBe(stub);
	});

	it('matches when projectRoot is reached through a symlink', () => {
		const linked = `${projectRoot}-link`;
		fs.symlinkSync(projectRoot, linked);
		try {
			const config = withDevtoolsPruning(
				{ resolver: {} },
				{ enabled: true, projectRoot: linked, replace: [host] },
			) as { resolver: { resolveRequest: ResolveRequest } };
			expect(
				resolveWith(config.resolver.resolveRequest, '../lib/devtools/host'),
			).toBe(stub);
		} finally {
			fs.rmSync(linked, { force: true });
		}
	});

	it('leaves unrelated imports alone', () => {
		expect(resolveWith(pruning([host]), '../lib/devtools/other')).toBe(
			'src/lib/devtools/other.ts',
		);
	});

	it('refuses an entry whose stub or path names no file', () => {
		expect(() =>
			pruning([{ ...host, stub: 'src/lib/missing-stub.tsx' }]),
		).toThrow(
			/the stub for @\/lib\/devtools\/host, src\/lib\/missing-stub\.tsx/,
		);
		expect(() =>
			pruning([{ ...host, path: 'src/lib/devtools/moved' }]),
		).toThrow(/the path for @\/lib\/devtools\/host, src\/lib\/devtools\/moved/);
	});

	it('refuses an alias without a path, which relative imports would miss', () => {
		expect(() => pruning([{ module: host.module, stub }])).toThrow(
			/cannot find the file @\/lib\/devtools\/host resolves to\. Set its `path`/,
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
