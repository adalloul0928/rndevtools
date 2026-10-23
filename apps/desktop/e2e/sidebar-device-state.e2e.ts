import { expect, test } from '@playwright/test';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;
test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
});
test.afterAll(async () => {
	await harness?.close();
});

test('sidebar dot follows the selected Simulator rather than helper availability', async () => {
	await harness.openPanel('simulator/fleet');
	const select = harness.window.getByRole('combobox', {
		name: 'Selected Simulator',
	});
	const options = await select.locator('option').evaluateAll((items) =>
		items.map((item) => ({
			value: (item as HTMLOptionElement).value,
			text: item.textContent ?? '',
		}))
	);
	const shutdown = options.find((option) => /· shutdown$/i.test(option.text));
	test.skip(
		!shutdown,
		'A shutdown Simulator must exist in the read-only inventory.'
	);
	if (!shutdown) return;
	for (const theme of ['dark', 'light'] as const) {
		await harness.openPanel('simulator/settings');
		await harness.window
			.getByRole('button', {
				name: theme === 'dark' ? 'Dark' : 'Light',
				exact: true,
			})
			.click();
		await select.selectOption(shutdown.value);
		const dot = harness.window.locator('.simulator-sidebar .device-status');
		await expect(dot).toHaveAttribute('aria-label', 'Simulator Shutdown');
		await expect(dot).not.toHaveClass(/is-online/);
		await harness.window.setViewportSize({ width: 1040, height: 700 });
		await harness.screenshot(`sidebar-shutdown-${theme}`);
	}
	const booted = options.find((option) => /· booted$/i.test(option.text));
	if (booted) {
		await select.selectOption(booted.value);
		await expect(
			harness.window.locator('.simulator-sidebar .device-status')
		).toHaveClass(/is-online/);
	}
});
