import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	type ElectronApplication,
	_electron as electron,
	type Page,
} from '@playwright/test';

const appRoot = resolve(__dirname, '..');
const rendererEntry = join(appRoot, 'dist', 'renderer', 'index.html');
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');

/**
 * Connected-app tool ids, mirrored from `src/renderer/tool-config.ts`. The
 * source list is not importable here (the renderer bundle pulls in browser-only
 * modules), so the smoke spec asserts this array against the built bundle.

 *
 * @public
 */
export const connectedToolIds = [
	'network',
	'console',
	'storage',
	'query',
	'zustand',
	'restore',
	'scenarios',
	'identity',
	'routes',
	'environment',
	'components',
	'camera',
	'performance',
	'diagnostics',
] as const;

/** Simulator tool ids, mirrored from `src/renderer/simulator/simulator-config.ts`.
 *
 * @public
 */
export const simulatorToolIds = [
	'fleet',
	'actions',
	'slimming',
	'captures',
	'automation',
	'builds',
	'settings',
] as const;

/** @public */
export type ConnectedToolId = (typeof connectedToolIds)[number];
/** @public */
export type SimulatorToolId = (typeof simulatorToolIds)[number];
/** @public */
export type PanelId = ConnectedToolId | `simulator/${SimulatorToolId}`;

/** Every panel the harness knows how to open, in navigation order.
 *
 * @public
 */
export const allPanelIds: PanelId[] = [
	...connectedToolIds,
	...simulatorToolIds.map((id): PanelId => `simulator/${id}`),
];

const screenshotDir =
	process.env.RNDEVTOOLS_E2E_SCREENSHOT_DIR ?? '/tmp/rndevtools-ux/baseline';

/** Build the app if the renderer or main bundle is missing.
 *
 * @public
 */
export function ensureBuilt(): void {
	if (existsSync(rendererEntry) && existsSync(mainEntry)) return;
	execFileSync('pnpm', ['--filter', '@rndevtools/desktop', 'build'], {
		cwd: resolve(appRoot, '..', '..'),
		stdio: 'inherit',
	});
}

/** @public */
export class DesktopHarness {
	private constructor(
		readonly app: ElectronApplication,
		readonly window: Page
	) {}

	static async launch(): Promise<DesktopHarness> {
		ensureBuilt();
		// Each launch gets its own userData dir so Electron's single-instance
		// lock (src/main/index.ts) does not evict concurrent or back-to-back
		// runs, and its own ephemeral broker port so brokers never collide.
		const userDataDir = mkdtempSync(join(tmpdir(), 'rndevtools-e2e-'));
		const app = await electron.launch({
			args: [
				mainEntry,
				'--no-sandbox',
				'--disable-gpu',
				`--user-data-dir=${userDataDir}`,
			],
			cwd: appRoot,
			env: {
				...process.env,
				RNDEVTOOLS_DEMO: 'true',
				RNDEVTOOLS_PORT: '0',
				NODE_ENV: 'production',
			},
		});
		const window = await app.firstWindow();
		await window.waitForLoadState('domcontentloaded');
		await window.waitForSelector('.desktop-provider', { timeout: 30_000 });
		return new DesktopHarness(app, window);
	}

	/**
	 * Navigate to a panel by id. Connected tools use `#connected/<id>`;
	 * simulator tools use `#simulator/<id>`. Resolves once the panel's Suspense
	 * fallback has cleared.
	 */
	async openPanel(id: PanelId): Promise<void> {
		const hash = id.startsWith('simulator/') ? `#${id}` : `#connected/${id}`;
		await this.window.evaluate((target) => {
			window.location.hash = target;
			window.dispatchEvent(new HashChangeEvent('hashchange'));
		}, hash);
		await this.window
			.waitForSelector('.panel-loading', {
				state: 'detached',
				timeout: 15_000,
			})
			.catch(() => {
				// No loading shim rendered (panel resolved synchronously) — fine.
			});
		await this.window.waitForTimeout(250);
	}

	/** Capture a full-window screenshot into the baseline directory. */
	async screenshot(name: string): Promise<string> {
		mkdirSync(screenshotDir, { recursive: true });
		const path = join(screenshotDir, `${name}.png`);
		await this.window.screenshot({ path });
		return path;
	}

	/** True when the renderer error boundary is currently showing. */
	async hasErrorBoundary(): Promise<boolean> {
		return (await this.window.locator('.fatal-error').count()) > 0;
	}

	async close(): Promise<void> {
		await this.app.close();
	}
}
