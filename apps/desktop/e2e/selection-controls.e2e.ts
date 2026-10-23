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
	test(`selection controls share sizing and keyboard navigation in ${theme}`, async () => {
		const window = harness.window;
		await harness.openPanel('simulator/settings');
		const appearance = window.getByRole('group', {
			name: 'Theme',
			exact: true,
		});
		await appearance.getByRole('button', { name: theme, exact: true }).click();
		await expect(window.locator('html')).toHaveAttribute(
			'data-theme',
			theme.toLowerCase()
		);
		expect((await appearance.boundingBox())?.height).toBe(32);

		await harness.openPanel('query');
		const status = window.getByRole('group', {
			name: 'Query status',
			exact: true,
		});
		expect((await status.boundingBox())?.height).toBe(32);
		await status.getByRole('button', { name: 'All', exact: true }).focus();
		await window.keyboard.press('End');
		const errors = status.getByRole('button', { name: 'Errors', exact: true });
		await expect(errors).toBeFocused();
		await expect(errors).toHaveAttribute('aria-pressed', 'true');
		await window.keyboard.press('ArrowRight');
		await expect(
			status.getByRole('button', { name: 'All', exact: true })
		).toBeFocused();
		await window.keyboard.press('ArrowRight');
		await expect(
			status.getByRole('button', { name: 'Active', exact: true })
		).toHaveAttribute('aria-pressed', 'true');
		await window.keyboard.press('Home');
		await expect(
			status.getByRole('button', { name: 'All', exact: true })
		).toHaveAttribute('aria-pressed', 'true');

		await harness.openPanel('network');
		await window.locator('.desktop-grid [role="row"]').nth(1).click();
		const tabs = window.getByRole('tablist', {
			name: 'Request detail',
			exact: true,
		});
		expect((await tabs.boundingBox())?.height).toBe(32);
		await tabs.getByRole('tab').first().focus();
		await window.keyboard.press('End');
		await expect(tabs.getByRole('tab').last()).toBeFocused();
		await expect(tabs.getByRole('tab').last()).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await window.keyboard.press('Home');
		await expect(tabs.getByRole('tab').first()).toHaveAttribute(
			'aria-selected',
			'true'
		);
		await expect(window.getByRole('tabpanel')).toHaveAttribute(
			'aria-labelledby',
			(await tabs.getByRole('tab').first().getAttribute('id')) ?? ''
		);
		expect(
			await window.evaluate(
				() =>
					document.documentElement.scrollWidth >
					document.documentElement.clientWidth
			)
		).toBe(false);
	});
}
