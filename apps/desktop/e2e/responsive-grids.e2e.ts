import { expect, test } from '@playwright/test';
import { DesktopHarness, type PanelId } from './harness';

let harness: DesktopHarness;
test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});
test.afterAll(async () => {
	await harness?.close();
});

const panels: { id: PanelId; hidden: string[] }[] = [
	{ id: 'network', hidden: ['Size', 'Started'] },
	{ id: 'storage', hidden: ['Type', 'Size'] },
	{ id: 'query', hidden: ['Observers', 'Updated'] },
];

for (const theme of ['dark', 'light'] as const) {
	test(`diagnostic grids fit narrow panes and restore secondary columns in ${theme}`, async () => {
		await harness.openPanel('simulator/settings');
		await harness.window
			.getByRole('button', {
				name: theme === 'dark' ? 'Dark' : 'Light',
				exact: true,
			})
			.click();
		await expect(harness.window.locator('html')).toHaveAttribute(
			'data-theme',
			theme
		);
		for (const { id, hidden } of panels) {
			await harness.window.setViewportSize({ width: 1040, height: 700 });
			await harness.openPanel(id);
			const grid = harness.window.locator('.desktop-grid');
			await expect(grid).toBeVisible();
			for (const name of hidden)
				await expect(
					grid.getByRole('columnheader', { name, exact: true })
				).toHaveCount(0);
			const scroll = grid.locator('.table__scroll-container');
			await expect
				.poll(() =>
					scroll.evaluate(
						(element) => element.scrollWidth - element.clientWidth
					)
				)
				.toBeLessThanOrEqual(1);
			await harness.screenshot(`${id}-compact-${theme}`);
			await harness.window.setViewportSize({ width: 1780, height: 900 });
			for (const name of hidden)
				await expect(
					grid.getByRole('columnheader', { name, exact: true })
				).toBeVisible();
		}
	});
}
