import path from 'node:path';
import { URL } from 'node:url';

const MAX_EXTERNAL_URL_LENGTH = 8 * 1024;
const RENDERER_ASSET_EXTENSIONS = new Set([
	'.css',
	'.html',
	'.js',
	'.png',
	'.svg',
	'.woff2',
]);

export const PACKAGED_RENDERER_SCHEME = 'rndevtools';
export const PACKAGED_RENDERER_URL = `${PACKAGED_RENDERER_SCHEME}://app/index.html`;
export const PACKAGED_RENDERER_CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob: rndevtools-capture:",
	"font-src 'self' data:",
	"connect-src 'self'",
	"object-src 'none'",
	"frame-src 'none'",
	"frame-ancestors 'none'",
	"worker-src 'none'",
	'media-src rndevtools-capture:',
	"base-uri 'self'",
	"form-action 'self'",
].join('; ');

function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
	return (
		normalized === 'localhost' ||
		normalized === '::1' ||
		normalized === '0:0:0:0:0:0:0:1' ||
		/^127(?:\.\d{1,3}){3}$/.test(normalized)
	);
}

/**
 * electron-vite provides this URL during local development. Packaged builds
 * must never grant the preload bridge to content selected through an ambient
 * environment variable.
 */
export function trustedDevelopmentRendererUrl(
	value: string | undefined,
	isPackaged: boolean
): string | undefined {
	if (isPackaged || !value || value.length > MAX_EXTERNAL_URL_LENGTH)
		return undefined;
	try {
		const url = new URL(value);
		if (
			(url.protocol !== 'http:' && url.protocol !== 'https:') ||
			!isLoopbackHostname(url.hostname) ||
			url.username ||
			url.password
		) {
			return undefined;
		}
		return url.href;
	} catch {
		return undefined;
	}
}

export function urlsMatchWithoutHash(left: string, right: string): boolean {
	try {
		const leftUrl = new URL(left);
		const rightUrl = new URL(right);
		leftUrl.hash = '';
		rightUrl.hash = '';
		return leftUrl.href === rightUrl.href;
	} catch {
		return false;
	}
}

/**
 * Maps the private renderer origin to the generated renderer directory only.
 * The custom protocol lets packaged builds keep Electron's legacy file://
 * privileges disabled without exposing arbitrary local files to the renderer.
 */
export function packagedRendererAssetPath(
	rendererRoot: string,
	requestUrl: string
): string | undefined {
	if (requestUrl.length > MAX_EXTERNAL_URL_LENGTH) return undefined;
	try {
		const url = new URL(requestUrl);
		if (
			url.protocol !== `${PACKAGED_RENDERER_SCHEME}:` ||
			url.hostname !== 'app' ||
			url.port ||
			url.username ||
			url.password
		) {
			return undefined;
		}
		const authorityOffset = requestUrl.indexOf('://') + 3;
		const rawPathOffset = requestUrl.indexOf('/', authorityOffset);
		const rawPath =
			rawPathOffset === -1
				? '/'
				: (requestUrl.slice(rawPathOffset).split(/[?#]/, 1)[0] ?? '/');
		const pathname = decodeURIComponent(rawPath);
		if (
			!pathname.startsWith('/') ||
			pathname.includes('\\') ||
			pathname.includes('\0')
		) {
			return undefined;
		}
		const segments = pathname.split('/').filter(Boolean);
		if (segments.length === 0) segments.push('index.html');
		if (segments.some((segment) => segment === '.' || segment === '..')) {
			return undefined;
		}
		const root = path.resolve(rendererRoot);
		const candidate = path.resolve(root, ...segments);
		if (!candidate.startsWith(`${root}${path.sep}`)) return undefined;
		if (!RENDERER_ASSET_EXTENSIONS.has(path.extname(candidate).toLowerCase())) {
			return undefined;
		}
		return candidate;
	} catch {
		return undefined;
	}
}
