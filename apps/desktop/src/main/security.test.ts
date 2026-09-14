import { describe, expect, it } from 'vitest';
import {
	PACKAGED_RENDERER_CONTENT_SECURITY_POLICY,
	PACKAGED_RENDERER_URL,
	packagedRendererAssetPath,
	trustedDevelopmentRendererUrl,
	urlsMatchWithoutHash,
} from './security';

describe('desktop URL boundaries', () => {
	it('accepts only loopback renderer URLs in unpackaged development', () => {
		expect(trustedDevelopmentRendererUrl('http://localhost:5173/', false)).toBe(
			'http://localhost:5173/'
		);
		expect(trustedDevelopmentRendererUrl('http://127.0.0.1:5173/', false)).toBe(
			'http://127.0.0.1:5173/'
		);
		expect(
			trustedDevelopmentRendererUrl('https://attacker.example/', false)
		).toBeUndefined();
		expect(
			trustedDevelopmentRendererUrl('http://localhost:5173/', true)
		).toBeUndefined();
	});

	it('matches renderer entries while permitting only hash navigation', () => {
		expect(
			urlsMatchWithoutHash(
				'file:///Applications/PUMPD/index.html#network',
				'file:///Applications/PUMPD/index.html'
			)
		).toBe(true);
		expect(
			urlsMatchWithoutHash(
				'file:///Applications/PUMPD/other.html',
				'file:///Applications/PUMPD/index.html'
			)
		).toBe(false);
	});

	it('maps only private renderer assets below the generated root', () => {
		const root =
			'/Applications/PUMPD.app/Contents/Resources/app.asar/dist/renderer';
		expect(packagedRendererAssetPath(root, PACKAGED_RENDERER_URL)).toBe(
			`${root}/index.html`
		);
		expect(
			packagedRendererAssetPath(
				root,
				'pumpd-devtools://app/assets/index.js?v=1'
			)
		).toBe(`${root}/assets/index.js`);
		expect(
			packagedRendererAssetPath(root, 'pumpd-devtools://other/index.html')
		).toBeUndefined();
		expect(
			packagedRendererAssetPath(
				root,
				'pumpd-devtools://app/%2e%2e/main/index.js'
			)
		).toBeUndefined();
		expect(
			packagedRendererAssetPath(root, 'pumpd-devtools://app/private.json')
		).toBeUndefined();
	});

	it('uses a packaged CSP that cannot connect to arbitrary loopback services', () => {
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).toContain(
			"connect-src 'self'"
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).not.toContain(
			'localhost'
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).not.toContain(
			'127.0.0.1'
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).not.toContain(
			"'unsafe-eval'"
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).toContain(
			"img-src 'self' data: blob: pumpd-capture:"
		);
		expect(PACKAGED_RENDERER_CONTENT_SECURITY_POLICY).toContain(
			'media-src pumpd-capture:'
		);
	});
});
