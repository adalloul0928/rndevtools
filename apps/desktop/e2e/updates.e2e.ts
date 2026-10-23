import { expect, test } from '@playwright/test';
import { IPC_CHANNELS } from '../src/shared/ipc';
import type { UpdateState } from '../src/shared/update-protocol';
import { DesktopHarness } from './harness';

let harness: DesktopHarness;

test.beforeAll(async () => {
	harness = await DesktopHarness.launch();
	await harness.window.setViewportSize({ width: 1040, height: 700 });
});

test.afterAll(async () => {
	await harness?.close();
});

test('source builds offer no update or restart action', async () => {
	await expect(harness.window.locator('.titlebar-update')).toHaveCount(0);
	await harness.openPanel('simulator/settings');
	await expect(
		harness.window.getByText(
			'Updates are available in the installed macOS release.'
		)
	).toBeVisible();
});

async function setState(state: UpdateState) {
	await harness.app.evaluate(
		({ BrowserWindow, ipcMain }, { state, channels }) => {
			ipcMain.removeHandler(channels.getUpdateState);
			ipcMain.handle(channels.getUpdateState, () => state);
			for (const window of BrowserWindow.getAllWindows())
				window.webContents.send(channels.updateStateChanged, state);
		},
		{ state, channels: IPC_CHANNELS }
	);
}

for (const theme of ['dark', 'light'] as const) {
	test(`update actions stay accessible at 1040×700 in ${theme}`, async () => {
		await harness.window.evaluate(
			(theme) => window.rnDevtools?.setAppearance(theme),
			theme
		);
		await expect(harness.window.locator('html')).toHaveAttribute(
			'data-theme',
			theme
		);
		await harness.app.evaluate(({ ipcMain, BrowserWindow }, channels) => {
			ipcMain.removeHandler(channels.runUpdateOperation);
			ipcMain.handle(channels.runUpdateOperation, (_event, operation) => {
				const state = {
					currentVersion: '0.2.0',
					version: '0.3.0',
					status:
						operation === 'download'
							? 'downloading'
							: operation === 'install'
								? 'installing'
								: 'available',
					...(operation === 'download' ? { percent: 0 } : {}),
				};
				for (const window of BrowserWindow.getAllWindows())
					window.webContents.send(channels.updateStateChanged, state);
				return state;
			});
		}, IPC_CHANNELS);
		await harness.openPanel('simulator/settings');
		await setState({ status: 'idle', currentVersion: '0.2.0' });
		await harness.window
			.getByRole('button', { name: 'Check for updates', exact: true })
			.click();
		await harness.openPanel('network');
		const nav = harness.window.locator('header.titlebar');
		const available = nav.getByRole('button', {
			name: 'Update available',
			exact: true,
		});
		await expect(available).toBeVisible();
		await harness.screenshot(`update-available-${theme}`);
		await available.focus();
		await harness.window.keyboard.press('Enter');
		await expect(
			nav.getByRole('button', { name: 'Downloading 0%' })
		).toBeDisabled();
		await setState({
			status: 'downloading',
			currentVersion: '0.2.0',
			version: '0.3.0',
			percent: 42,
		});
		await expect(
			nav.getByRole('button', { name: 'Downloading 42%' })
		).toBeDisabled();
		await setState({
			status: 'verifying',
			currentVersion: '0.2.0',
			version: '0.3.0',
		});
		await expect(
			nav.getByRole('button', { name: 'Verifying update…' })
		).toBeDisabled();
		await setState({
			status: 'error',
			currentVersion: '0.2.0',
			version: '0.3.0',
			error: 'Could not complete the update. Try again.',
		});
		await nav.getByRole('button', { name: 'Retry update' }).click();
		await expect(available).toBeVisible();
		await setState({
			status: 'ready',
			currentVersion: '0.2.0',
			version: '0.3.0',
		});
		const restart = nav.getByRole('button', {
			name: 'Restart to update',
			exact: true,
		});
		await expect(restart).toBeEnabled();
		await harness.screenshot(`update-ready-${theme}`);
		const layout = await nav.evaluate((header) => {
			const bounds = header.getBoundingClientRect();
			const buttons = [...header.querySelectorAll('button')];
			return {
				overflow:
					document.documentElement.scrollWidth >
					document.documentElement.clientWidth,
				outside: buttons.some((button) => {
					const rect = button.getBoundingClientRect();
					return rect.right > bounds.right || rect.left < bounds.left;
				}),
			};
		});
		expect(layout).toEqual({ overflow: false, outside: false });
		await restart.click();
		await expect(
			nav.getByRole('button', { name: 'Restarting…' })
		).toBeDisabled();
		expect(await harness.hasErrorBoundary()).toBe(false);
	});
}
