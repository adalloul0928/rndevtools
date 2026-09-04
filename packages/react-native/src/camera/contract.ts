import type {
	DesktopCameraFixtureKind,
	DesktopCameraFixtureSnapshot,
} from '@pumpd/devtools/desktop-protocol';
import type { ImagePickerOptions, ImagePickerResult } from 'expo-image-picker';

export type PumpdCameraPicker = {
	launchCameraAsync: (
		options?: ImagePickerOptions
	) => Promise<ImagePickerResult>;
};

type MediaFixture = {
	kind: Extract<DesktopCameraFixtureKind, 'still' | 'qr' | 'video'>;
	label?: string;
	mimeType:
		| 'image/jpeg'
		| 'image/png'
		| 'image/webp'
		| 'video/mp4'
		| 'video/quicktime';
	dataBase64: string;
	width: number;
	height: number;
	durationMs?: number;
};

export type PumpdDebugCameraFixture =
	| MediaFixture
	| { kind: 'unavailable'; label?: string }
	| { kind: 'error'; label?: string; errorMessage: string };

export type PumpdCameraProvider = {
	launchCameraAsync: (
		picker: PumpdCameraPicker,
		options?: ImagePickerOptions
	) => Promise<ImagePickerResult>;
	setDebugFixture: (fixture: PumpdDebugCameraFixture) => Promise<void>;
	clearDebugFixture: () => Promise<void>;
	getDebugFixtureSnapshot: () => DesktopCameraFixtureSnapshot;
};
