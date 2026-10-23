import { expect, test } from '@playwright/test';
import { allPanelIds, DesktopHarness } from './harness';

/**
 * Integration-stage final visual pass. Opens every panel at the 1040x700
 * minimum window size, once in the dark theme and once in the light theme,
 * and screenshots each into the `final` directory for comparison against
 * `baseline`: `<id>.png` is dark and `<id>-light.png` is light. Also asserts
 * no panel renders an error boundary, the shell shows no horizontal overflow
 * at the minimum size, and the chosen theme survives every navigation.
 *
 * Each theme is chosen the way a user chooses it, through the Appearance
 * control on the Settings panel, so the pass does not depend on the OS
 * appearance the harness otherwise follows.
 *
 * Not part of the panel-agent contract; kept out of `quality` (matches
 * `*.e2e.ts`). Screenshot dir is overridden to `/tmp/rndevtools-ux/final`
 * via `RNDEVTOOLS_E2E_SCREENSHOT_DIR` when the integration agent runs it.
 */

type Theme = 'light' | 'dark';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
	await harness.window.setViewportSize({ width: 1040, height: 700 });
});

test.afterAll(async () => {
	await harness?.close();
});

/** Picks the theme in Settings and waits for the root element to carry it. */
async function chooseTheme(theme: Theme): Promise<void> {
	await harness.openPanel('simulator/settings');
	const option = harness.window.getByRole('button', {
		name: theme === 'light' ? 'Light' : 'Dark',
		exact: true,
	});
	await option.click();
	await expect(option).toHaveAttribute('aria-pressed', 'true');
	await expect(harness.window.locator('html')).toHaveAttribute(
		'data-theme',
		theme
	);
}

async function visitEveryPanel(theme: Theme): Promise<void> {
	for (const id of allPanelIds) {
		await harness.openPanel(id);
		expect(await harness.hasErrorBoundary(), `${id} crashed in ${theme}`).toBe(
			false
		);
		const overflow = await harness.window.evaluate(
			() =>
				document.documentElement.scrollWidth >
				document.documentElement.clientWidth
		);
		expect(
			overflow,
			`${id} overflows horizontally at 1040x700 in ${theme}`
		).toBe(false);
		await expect(harness.window.locator('html')).toHaveAttribute(
			'data-theme',
			theme
		);
		const name = id.replace('/', '-');
		await harness.screenshot(theme === 'dark' ? name : `${name}-light`);
	}
}

test('final visual pass: every panel at 1040x700 in the dark theme', async () => {
	await chooseTheme('dark');
	await visitEveryPanel('dark');
});

test('final visual pass: every panel at 1040x700 in the light theme', async () => {
	await chooseTheme('light');
	await visitEveryPanel('light');
});
