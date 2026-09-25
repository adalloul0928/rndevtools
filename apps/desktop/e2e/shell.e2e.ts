import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test.beforeEach(async () => {
	// Reset to a known workspace/panel before each control test.
	await harness.openPanel('network');
});

test('workspace switcher toggles between Connected App and Simulator', async () => {
	const { window } = harness;
	const simulator = window.getByRole('button', { name: /Simulator/ }).first();
	const connected = window.getByRole('button', { name: /Connected App/ });

	await simulator.click();
	await expect(simulator).toHaveAttribute('aria-pressed', 'true');
	await expect(window.locator('.simulator-sidebar')).toBeVisible();

	await connected.click();
	await expect(connected).toHaveAttribute('aria-pressed', 'true');
	await expect(
		window.locator('.desktop-sidebar:not(.simulator-sidebar)')
	).toBeVisible();
});

test('sidebar toggle button hides and shows the sidebar', async () => {
	const { window } = harness;
	await expect(window.locator('.desktop-sidebar')).toBeVisible();

	const toggle = window.getByRole('button', { name: /sidebar/i }).first();
	await toggle.click();
	await expect(window.locator('.desktop-sidebar')).toHaveCount(0);

	await toggle.click();
	await expect(window.locator('.desktop-sidebar')).toBeVisible();
});

test('connected sidebar nav selects a tool and marks it current', async () => {
	const { window } = harness;
	const consoleItem = window
		.locator('.tool-nav-item')
		.filter({ hasText: 'Console' });
	await consoleItem.click();
	await expect(consoleItem).toHaveAttribute('aria-current', 'page');
	// The hash reflects the selection.
	const hash = await window.evaluate(() => window.location.hash);
	expect(hash).toBe('#connected/console');
});

test('device picker exposes the demo device and keeps a selection', async () => {
	const { window } = harness;
	const select = window.getByLabel('Selected development device');
	await expect(select).toBeEnabled();
	const optionCount = await select.locator('option').count();
	expect(optionCount).toBeGreaterThan(0);
});

test('connection button jumps to Diagnostics', async () => {
	const { window } = harness;
	await window
		.getByRole('button', { name: /live connection.*open Diagnostics/i })
		.click();
	const hash = await window.evaluate(() => window.location.hash);
	expect(hash).toBe('#connected/diagnostics');
});

test('keyboard shortcuts switch workspaces and panels', async () => {
	const { window } = harness;
	const isMac = await window.evaluate(() =>
		navigator.platform.toLowerCase().includes('mac')
	);
	const modifier = isMac ? 'Meta' : 'Control';

	// Switch to the Simulator workspace (Shift+Mod+S).
	await window.keyboard.press(`${modifier}+Shift+S`);
	await expect(window.locator('.simulator-sidebar')).toBeVisible();

	// Mod+2 selects the App Actions simulator tool.
	await window.keyboard.press(`${modifier}+2`);
	await expect(window.evaluate(() => window.location.hash)).resolves.toBe(
		'#simulator/actions'
	);

	// Back to connected (Shift+Mod+C).
	await window.keyboard.press(`${modifier}+Shift+C`);
	await expect(
		window.locator('.desktop-sidebar:not(.simulator-sidebar)')
	).toBeVisible();
});

test('simulator sidebar footer opens Settings', async () => {
	const { window } = harness;
	await harness.openPanel('simulator/fleet');
	await window
		.getByRole('button', { name: /Simulator capability.*open Settings/i })
		.click();
	await expect(window.evaluate(() => window.location.hash)).resolves.toBe(
		'#simulator/settings'
	);
});

test('connected sidebar footer opens Diagnostics', async () => {
	const { window } = harness;
	await harness.openPanel('network');
	await window
		.getByRole('button', { name: /Broker.*open Diagnostics/i })
		.click();
	await expect(window.evaluate(() => window.location.hash)).resolves.toBe(
		'#connected/diagnostics'
	);
});

test('keyboard sidebar toggle hides and shows the sidebar', async () => {
	const { window } = harness;
	await harness.openPanel('network');
	const isMac = await window.evaluate(() =>
		navigator.platform.toLowerCase().includes('mac')
	);
	const modifier = isMac ? 'Meta' : 'Control';
	await expect(window.locator('.desktop-sidebar')).toBeVisible();
	await window.keyboard.press(`${modifier}+b`);
	await expect(window.locator('.desktop-sidebar')).toHaveCount(0);
	await window.keyboard.press(`${modifier}+b`);
	await expect(window.locator('.desktop-sidebar')).toBeVisible();
});

test('layout survives the 1040x700 minimum window size', async () => {
	const { window } = harness;
	await window.setViewportSize({ width: 1040, height: 700 });
	await expect(window.locator('.desktop-sidebar')).toBeVisible();
	await expect(window.locator('.desktop-main')).toBeVisible();
	// No horizontal scrollbar should appear on the shell body.
	const overflow = await window.evaluate(() => {
		const el = document.querySelector('.desktop-provider');
		return el ? el.scrollWidth - el.clientWidth : 0;
	});
	expect(overflow).toBeLessThanOrEqual(1);
	await harness.screenshot('shell-1040x700');
	await window.setViewportSize({ width: 1280, height: 832 });
});
