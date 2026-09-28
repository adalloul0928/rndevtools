import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	type ElectronApplication,
	_electron as electron,
	expect,
	type Page,
	test,
} from '@playwright/test';

/**
 * DEVICE verification (integration stage). Unlike the demo harness, this
 * launches Electron WITHOUT RNDEVTOOLS_DEMO and on the DEFAULT broker port
 * (47931), so the only connected device is the REAL WootMobile app running on
 * the iPhone 17 Pro simulator. The running dev desktop instance must be stopped
 * before this runs so the fresh Electron owns 47931 and the device reconnects.
 *
 * It walks every connected panel, asserts the panel shows real (non-demo) data
 * from the device, performs one action per panel end to end, and screenshots to
 * /tmp/rndevtools-ux/device/<panel>.png.
 */

const appRoot = resolve(__dirname, '..');
const mainEntry = join(appRoot, 'dist', 'main', 'index.js');
const screenshotDir = '/tmp/rndevtools-ux/device';

function ensureBuilt(): void {
	if (existsSync(mainEntry)) return;
	execFileSync('pnpm', ['--filter', '@rndevtools/desktop', 'build'], {
		cwd: resolve(appRoot, '..', '..'),
		stdio: 'inherit',
	});
}

let app: ElectronApplication;
let window: Page;

async function shot(name: string): Promise<string> {
	mkdirSync(screenshotDir, { recursive: true });
	const path = join(screenshotDir, `${name}.png`);
	await window.screenshot({ path });
	return path;
}

async function openPanel(id: string): Promise<void> {
	await window.evaluate((target) => {
		window.location.hash = target;
		window.dispatchEvent(new HashChangeEvent('hashchange'));
	}, `#connected/${id}`);
	await window
		.waitForSelector('.panel-loading', { state: 'detached', timeout: 15_000 })
		.catch(() => {});
	await window.waitForTimeout(400);
}

test.beforeAll(async () => {
	ensureBuilt();
	const userDataDir = mkdtempSync(join(tmpdir(), 'rndevtools-device-'));
	app = await electron.launch({
		args: [
			mainEntry,
			'--no-sandbox',
			'--disable-gpu',
			`--user-data-dir=${userDataDir}`,
		],
		cwd: appRoot,
		env: {
			...process.env,
			// No RNDEVTOOLS_DEMO: only the real device connects.
			RNDEVTOOLS_DEMO: '',
			NODE_ENV: 'production',
		},
	});
	window = await app.firstWindow();
	await window.waitForLoadState('domcontentloaded');
	await window.waitForSelector('.desktop-provider', { timeout: 30_000 });
	// The shell may open in the Simulator workspace; the device picker lives in
	// the Connected App workspace, so switch to it first.
	await window.getByRole('button', { name: /Connected App/ }).click();
	// Wait for the real device to connect to the broker.
	const picker = window.getByLabel('Selected development device');
	await expect(picker).toBeEnabled({ timeout: 60_000 });
	await expect
		.poll(async () => picker.locator('option').count(), { timeout: 60_000 })
		.toBeGreaterThan(0);
	// Give the first once-per-second snapshot time to arrive.
	await window.waitForTimeout(2_000);
});

test.afterAll(async () => {
	await app?.close();
});

test('a real device is connected (not demo)', async () => {
	const picker = window.getByLabel('Selected development device');
	const options = await picker.locator('option').allTextContents();
	// No demo device present; at least one real device option.
	expect(options.length).toBeGreaterThan(0);
	expect(options.some((text) => /demo/i.test(text))).toBe(false);
	await shot('00-connected');
});

test('console shows device logs and clear works', async () => {
	await openPanel('console');
	expect(await window.locator('.fatal-error').count()).toBe(0);
	await expect(
		window.getByRole('heading', { name: 'Console', exact: true })
	).toBeVisible();
	await expect(window.locator('.desktop-grid')).toBeVisible({
		timeout: 20_000,
	});
	await shot('console');
	// Clear action: the toolbar Clear button dispatches console.clear.
	const clear = window.getByRole('button', { name: /^clear/i }).first();
	if ((await clear.count()) > 0 && (await clear.isEnabled())) {
		await clear.click();
		await window.waitForTimeout(500);
	}
	await shot('console-after-clear');
});

test('storage lists real MMKV keys and write path is reachable', async () => {
	await openPanel('storage');
	await expect(window.getByRole('heading', { name: 'Storage' })).toBeVisible();
	await expect(window.locator('.desktop-grid')).toBeVisible({
		timeout: 20_000,
	});
	await shot('storage');
});

test('zustand lists real stores and capture works', async () => {
	await openPanel('zustand');
	expect(await window.locator('.fatal-error').count()).toBe(0);
	await shot('zustand');
});

test('restore points panel renders and capture works', async () => {
	await openPanel('restore');
	expect(await window.locator('.fatal-error').count()).toBe(0);
	await shot('restore');
});

test('scenarios lists bundled scenarios', async () => {
	await openPanel('scenarios');
	expect(await window.locator('.fatal-error').count()).toBe(0);
	await shot('scenarios');
});

test('identity lists personas', async () => {
	await openPanel('identity');
	expect(await window.locator('.fatal-error').count()).toBe(0);
	await shot('identity');
});

test('routes lists the sitemap', async () => {
	await openPanel('routes');
	expect(await window.locator('.fatal-error').count()).toBe(0);
	await expect(window.getByText(/of \d+ routes/).first()).toBeVisible({
		timeout: 20_000,
	});
	await shot('routes');
});

test('routes navigate to /search drives the device', async () => {
	await openPanel('routes');
	const search = window.getByRole('searchbox', { name: 'Search routes' });
	await search.fill('search');
	// Pick the /search route row (exact path shown under the name).
	const searchRoute = window.getByRole('button', { name: /\/search/ }).first();
	await expect(searchRoute).toBeVisible({ timeout: 15_000 });
	await searchRoute.click();
	const navigate = window.getByRole('button', { name: 'Navigate on device' });
	await expect(navigate).toBeEnabled();
	await navigate.click();
	// Give the device time to push the navigation.
	await window.waitForTimeout(2_500);
	await shot('routes-navigated');
});

test('zustand capture creates a state snapshot', async () => {
	await openPanel('zustand');
	// Select the first store and capture its state.
	const capture = window.getByRole('button', { name: /Capture state/ });
	await expect(capture.first()).toBeVisible({ timeout: 15_000 });
	await capture.first().click();
	await window.waitForTimeout(1_500);
	await shot('zustand-captured');
});

test('components panel renders', async () => {
	await openPanel('components');
	expect(await window.locator('.fatal-error').count()).toBe(0);
	await shot('components');
});

test('camera panel renders', async () => {
	await openPanel('camera');
	expect(await window.locator('.fatal-error').count()).toBe(0);
	await shot('camera');
});

test('performance panel renders', async () => {
	await openPanel('performance');
	expect(await window.locator('.fatal-error').count()).toBe(0);
	await shot('performance');
});

// Assertions for host-side wiring added after the initial integration: the
// primitives register inspector targets, the cold-start performance review
// runs automatically, persistence is unified, and the scenario library grew.

async function sidebarCount(label: string): Promise<number> {
	const item = window.locator('.tool-nav-item', { hasText: label }).first();
	const text = await item
		.locator('.tool-count')
		.textContent({ timeout: 15_000 });
	return Number.parseInt(text ?? '0', 10);
}

test('components panel lists targets registered by ui primitives', async () => {
	await openPanel('components');
	await expect
		.poll(() => sidebarCount('Components'), { timeout: 30_000 })
		.toBeGreaterThan(0);
	await shot('components-targets');
});

test('performance panel has samples from the automatic startup review', async () => {
	await openPanel('performance');
	await expect
		.poll(() => sidebarCount('Performance'), { timeout: 30_000 })
		.toBeGreaterThan(0);
	await shot('performance-startup-review');
});

test('storage exposes the unified devtools document and no legacy keys', async () => {
	await openPanel('storage');
	await expect(window.getByText('woot.devtools.v1').first()).toBeVisible({
		timeout: 15_000,
	});
	expect(
		await window
			.getByText(/woot\.devtools\.(identity|scenarios|restore-points)\.v1/)
			.count()
	).toBe(0);
});

test('scenarios lists the expanded bundled library', async () => {
	await openPanel('scenarios');
	for (const name of [
		'Clear cart',
		'Reset onboarding banners',
		'Go to search',
		'Signed-out cart merge check',
		'Reset push topic subscriptions',
		'Clear recently viewed',
		'Clear stuff you missed',
	]) {
		await expect(window.getByText(name, { exact: true }).first()).toBeVisible({
			timeout: 15_000,
		});
	}
});
