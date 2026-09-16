import {
	createImageOverlayController,
	type ImageOverlaySourceInput,
} from '@rndevtools/core/plugins';
import {
	deletePreparedRemoteImage,
	type PreparedRemoteImage,
	prepareRemoteImageOverlay,
} from './image-overlay-import';

function configuredRemoteHost(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		return url.protocol === 'https:' ? url.hostname.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}

const configuredRemoteHosts = [
	configuredRemoteHost(process.env.EXPO_PUBLIC_IMAGE_OVERLAY_ORIGIN),
	configuredRemoteHost(process.env.EXPO_PUBLIC_SUPABASE_URL),
].filter((host): host is string => Boolean(host));

export const RNDEVTOOLS_IMAGE_OVERLAY_LIMITS = Object.freeze({
	maxBytes: 20 * 1024 * 1024,
	maxDimension: 8_192,
	maxPixels: 40_000_000,
	allowedRemoteHosts: Object.freeze([...new Set(configuredRemoteHosts)]),
});

export const imageOverlay = createImageOverlayController(
	RNDEVTOOLS_IMAGE_OVERLAY_LIMITS,
);

let remoteImportGeneration = 0;
let activeRemoteImage: PreparedRemoteImage | null = null;

export function setLocalImageOverlaySource(
	source: ImageOverlaySourceInput,
): void {
	remoteImportGeneration += 1;
	imageOverlay.setSource(source);
	const previous = activeRemoteImage;
	activeRemoteImage = null;
	deletePreparedRemoteImage(previous);
}

export async function setRemoteImageOverlaySource(url: string): Promise<void> {
	remoteImportGeneration += 1;
	const generation = remoteImportGeneration;
	const prepared = await prepareRemoteImageOverlay(
		url,
		RNDEVTOOLS_IMAGE_OVERLAY_LIMITS,
	);
	if (generation !== remoteImportGeneration) {
		deletePreparedRemoteImage(prepared);
		return;
	}
	try {
		imageOverlay.setSource(prepared.source);
	} catch (error) {
		deletePreparedRemoteImage(prepared);
		throw error;
	}
	const previous = activeRemoteImage;
	activeRemoteImage = prepared;
	deletePreparedRemoteImage(previous);
}

export function clearImageOverlay(): void {
	remoteImportGeneration += 1;
	imageOverlay.clear();
	const previous = activeRemoteImage;
	activeRemoteImage = null;
	deletePreparedRemoteImage(previous);
}
