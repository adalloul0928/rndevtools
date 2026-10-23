import { expect, test } from '@playwright/test';
import { connectedToolIds, DesktopHarness, panelHeadings } from './harness';

let harness: DesktopHarness;
test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
	await harness.window.setViewportSize({ width: 1040, height: 700 });
});
test.afterAll(async () => {
	await harness?.close();
});

for (const theme of ['Dark', 'Light']) {
	test(`connected panels use a compact readable hierarchy in ${theme}`, async () => {
		const page = harness.window;
		await harness.openPanel('simulator/settings');
		await page.getByRole('button', { name: theme, exact: true }).click();
		await expect(page.locator('html')).toHaveAttribute(
			'data-theme',
			theme.toLowerCase()
		);
		await harness.openPanel('restore');
		const detailTitle = page.getByRole('heading', {
			name: 'Before empty-state QA',
			exact: true,
		});
		expect(
			await detailTitle.evaluate((node) =>
				parseFloat(getComputedStyle(node).fontSize)
			)
		).toBe(16);
		for (const panel of connectedToolIds.filter((id) => id !== 'network')) {
			await harness.openPanel(panel);
			await expect(
				page
					.getByRole('heading', { name: panelHeadings[panel], exact: true })
					.first()
			).toBeVisible();
			expect(await harness.hasErrorBoundary()).toBe(false);
			const captions = await page
				.locator('.panel-label')
				.evaluateAll((nodes) =>
					nodes.map((node) => getComputedStyle(node).textTransform)
				);
			for (const transform of captions) expect(transform).toBe('none');
			const headings = await page
				.locator('.connected-panel h2')
				.evaluateAll((nodes) =>
					nodes.map((node) => parseFloat(getComputedStyle(node).fontSize))
				);
			for (const size of headings) expect(size).toBeLessThanOrEqual(16);
			expect(
				await page.evaluate(
					() =>
						document.documentElement.scrollWidth >
						document.documentElement.clientWidth
				)
			).toBe(false);
			await harness.screenshot(`connected-${panel}-${theme.toLowerCase()}`);
		}
		await harness.openPanel('environment');
		expect(
			await page
				.getByText('Application', { exact: true })
				.evaluate((node) => getComputedStyle(node).textTransform)
		).toBe('none');
		await harness.openPanel('restore');
		expect(
			await page
				.locator('.panel-item[aria-pressed="true"]')
				.first()
				.evaluate((node) => getComputedStyle(node).boxShadow)
		).not.toBe('none');
	});
}
