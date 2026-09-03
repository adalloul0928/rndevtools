import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { diagnosticErrorText } from '@pumpd/devtools/redact';
import {
	app,
	BrowserWindow,
	dialog,
	type IpcMainInvokeEvent,
	ipcMain,
	nativeTheme,
	net,
	protocol,
	type WebContents,
} from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import {
	DEFAULT_BROKER_HOST,
	DEFAULT_BROKER_PORT,
	type DesktopBootstrap,
	type DesktopState,
	desktopActionSchema,
} from '../shared/protocol';
import { DesktopBroker } from './broker';
import {
	PACKAGED_RENDERER_CONTENT_SECURITY_POLICY,
	PACKAGED_RENDERER_SCHEME,
	PACKAGED_RENDERER_URL,
	packagedRendererAssetPath,
	trustedDevelopmentRendererUrl,
	urlsMatchWithoutHash,
} from './security';

protocol.registerSchemesAsPrivileged([
	{
		scheme: PACKAGED_RENDERER_SCHEME,
		privileges: {
			codeCache: true,
			secure: true,
			standard: true,
		},
	},
]);

const brokerToken = process.env.PUMPD_DEVTOOLS_TOKEN;
const broker = new DesktopBroker({
	host: process.env.PUMPD_DEVTOOLS_BIND_ADDRESS ?? DEFAULT_BROKER_HOST,
	port: Number(process.env.PUMPD_DEVTOOLS_PORT ?? DEFAULT_BROKER_PORT),
	...(brokerToken === undefined ? {} : { token: brokerToken }),
	allowWildcardBind: process.env.PUMPD_DEVTOOLS_ALLOW_WILDCARD === 'true',
	includeDemoDevice: process.env.PUMPD_DEVTOOLS_DEMO === 'true',
});
const windows = new Set<BrowserWindow>();
let brokerStopped = false;
let shutdownStarted = false;

function rendererEntryUrl(): string {
	return (
		trustedDevelopmentRendererUrl(process.env.ELECTRON_RENDERER_URL, app.isPackaged) ??
		PACKAGED_RENDERER_URL
	);
}

function registerRendererProtocol(): void {
	const rendererRoot = path.join(__dirname, '../renderer');
	protocol.handle(PACKAGED_RENDERER_SCHEME, async (request) => {
		const assetPath = packagedRendererAssetPath(rendererRoot, request.url);
		if (!assetPath) {
			return new Response('Not found', {
				headers: { 'content-type': 'text/plain; charset=utf-8' },
				status: 404,
			});
		}
		const response = await net.fetch(pathToFileURL(assetPath).href);
		if (path.extname(assetPath).toLowerCase() !== '.html') return response;
		const headers = new Headers(response.headers);
		headers.set('content-security-policy', PACKAGED_RENDERER_CONTENT_SECURITY_POLICY);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	});
}

function assertTrustedRenderer(event: IpcMainInvokeEvent): void {
	const senderUrl = event.senderFrame?.url ?? event.sender.getURL();
	if (!urlsMatchWithoutHash(senderUrl, rendererEntryUrl())) {
		throw new Error('Rejected IPC from an untrusted renderer.');
	}
}

function sendState(webContents: WebContents, state: DesktopState): void {
	if (webContents.isDestroyed()) return;
	try {
		webContents.send(IPC_CHANNELS.stateChanged, state);
	} catch {
		// A renderer can disappear between the destroyed check and send.
	}
}

function broadcastState(state: DesktopState): void {
	for (const window of windows) sendState(window.webContents, state);
}

function registerIpc(): void {
	ipcMain.handle(IPC_CHANNELS.getBootstrap, (event): DesktopBootstrap => {
		assertTrustedRenderer(event);
		return {
			state: broker.getState(),
			platform: process.platform,
			versions: {
				app: app.getVersion(),
				electron: process.versions.electron,
				chrome: process.versions.chrome,
				node: process.versions.node,
			},
		};
	});
	ipcMain.handle(IPC_CHANNELS.runAction, async (event, value: unknown) => {
		assertTrustedRenderer(event);
		const action = desktopActionSchema.parse(value);
		return broker.dispatchAction(action);
	});
}

function createWindow(): BrowserWindow {
	const window = new BrowserWindow({
		width: 1480,
		height: 940,
		minWidth: 1040,
		minHeight: 700,
		show: false,
		backgroundColor: '#000000',
		title: 'PUMPD Devtools',
		titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
		// Centers the 12px traffic lights in the 48px titlebar the renderer draws.
		trafficLightPosition: { x: 16, y: 18 },
		titleBarOverlay:
			process.platform === 'darwin'
				? false
				: { color: '#090909', symbolColor: '#a1a1a1', height: 48 },
		webPreferences: {
			preload: path.join(__dirname, '../preload/index.js'),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			webSecurity: true,
			allowRunningInsecureContent: false,
			devTools: !app.isPackaged,
			navigateOnDragDrop: false,
			safeDialogs: true,
			spellcheck: false,
			webviewTag: false,
		},
	});
	windows.add(window);
	window.on('closed', () => windows.delete(window));
	window.once('ready-to-show', () => window.show());
	window.webContents.session.setPermissionRequestHandler(
		(webContents, permission, callback, details) => {
			callback(
				webContents === window.webContents &&
					details.isMainFrame &&
					urlsMatchWithoutHash(details.requestingUrl, rendererEntryUrl()) &&
					permission === 'clipboard-sanitized-write'
			);
		}
	);
	window.webContents.session.setPermissionCheckHandler(
		(webContents, permission, _requestingOrigin, details) =>
			webContents === window.webContents &&
			details.isMainFrame &&
			details.requestingUrl !== undefined &&
			urlsMatchWithoutHash(details.requestingUrl, rendererEntryUrl()) &&
			permission === 'clipboard-sanitized-write'
	);

	window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
	window.webContents.on('will-attach-webview', (event) => event.preventDefault());
	window.webContents.on('will-navigate', (event, url) => {
		if (!urlsMatchWithoutHash(url, rendererEntryUrl())) event.preventDefault();
	});
	window.webContents.on('will-redirect', (event, url) => {
		if (!urlsMatchWithoutHash(url, rendererEntryUrl())) event.preventDefault();
	});

	const rendererLoad = window.loadURL(rendererEntryUrl());
	void rendererLoad.catch((error: unknown) => {
		dialog.showErrorBox(
			'PUMPD Devtools renderer could not load',
			diagnosticErrorText(error).slice(0, 8 * 1024)
		);
		if (!window.isDestroyed()) window.destroy();
		app.quit();
	});
	return window;
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		const window = BrowserWindow.getAllWindows()[0];
		if (!window) return;
		if (window.isMinimized()) window.restore();
		window.focus();
	});

	void app
		.whenReady()
		.then(async () => {
			nativeTheme.themeSource = 'dark';
			if (
				!trustedDevelopmentRendererUrl(
					process.env.ELECTRON_RENDERER_URL,
					app.isPackaged
				)
			) {
				registerRendererProtocol();
			}
			registerIpc();
			broker.subscribe(broadcastState);
			await broker.start();
			if (shutdownStarted) return;
			createWindow();

			app.on('activate', () => {
				if (!shutdownStarted && BrowserWindow.getAllWindows().length === 0) {
					createWindow();
				}
			});
		})
		.catch((error: unknown) => {
			dialog.showErrorBox(
				'PUMPD Devtools could not start',
				diagnosticErrorText(error).slice(0, 8 * 1024)
			);
			app.quit();
		});
}

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
	if (brokerStopped) return;
	event.preventDefault();
	if (shutdownStarted) return;
	shutdownStarted = true;
	void broker.stop().finally(() => {
		brokerStopped = true;
		app.quit();
	});
});
