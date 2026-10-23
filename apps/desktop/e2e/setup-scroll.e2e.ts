import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;
test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
	await harness.window.setViewportSize({ width: 1040, height: 700 });
});
test.afterAll(async () => {
	await harness?.close();
});

for (const theme of ['Dark', 'Light']) {
	test(`setup keeps its scroll edge visible in ${theme}`, async () => {
		const page = harness.window;
		await harness.openPanel('simulator/settings');
		await page.getByRole('button', { name: theme, exact: true }).click();
		await page
			.getByRole('button', { name: 'Run setup again', exact: true })
			.click();
		const card = page.locator('.setup-stage-card');
		await expect(card).toBeVisible();
		const bounds = await card.evaluate((node) => ({
			right: node.getBoundingClientRect().right,
			parentRight: node.parentElement?.getBoundingClientRect().right ?? 0,
		}));
		expect(bounds.right).toBeLessThanOrEqual(bounds.parentRight + 1);
		// A long result must remain scrollable using only the keyboard.
		await card.evaluate((node) => {
			const fixture = document.createElement('div');
			fixture.style.height = '1200px';
			fixture.textContent = 'Long setup result fixture';
			node.append(fixture);
		});
		await card.focus();
		await page.keyboard.press('End');
		await expect
			.poll(() => card.evaluate((node) => node.scrollTop))
			.toBeGreaterThan(0);
		await harness.screenshot(`setup-scroll-${theme.toLowerCase()}`);
		await page
			.getByRole('button', { name: 'Close setup', exact: true })
			.click();
	});
}
