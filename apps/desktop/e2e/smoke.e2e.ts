import { expect, test } from '@playwright/test';
import { allPanelIds, DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});

test.afterAll(async () => {
	await harness?.close();
});

test('every panel renders without an error boundary', async () => {
	const failures: string[] = [];

	for (const panelId of allPanelIds) {
		await harness.openPanel(panelId);
		const safeName = panelId.replace('/', '-');
		await harness.screenshot(safeName);

		if (await harness.hasErrorBoundary()) {
			failures.push(panelId);
		}
	}

	expect(failures, `panels that crashed: ${failures.join(', ')}`).toEqual([]);
});

test('the app shell exposes both workspaces and the sidebar', async () => {
	await harness.openPanel('network');
	// Workspace switcher and sidebar navigation are the shell's primary controls.
	await expect(
		harness.window.getByRole('button', { name: /Connected App/ })
	).toBeVisible();
	await expect(
		harness.window.getByRole('button', { name: /Simulator/ }).first()
	).toBeVisible();
	await expect(harness.window.locator('.desktop-sidebar')).toBeVisible();
});
