import {
	type DesktopDeviceInfoSnapshot,
	RNDEVTOOLS_ACTION_CAPABILITIES,
	RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS,
} from '@rndevtools/core/desktop-protocol';
import { redactDiagnosticText } from '@rndevtools/core/redact';
import { truncateText } from '@rndevtools/core/serialize';

function own(value: unknown, key: string): unknown {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error();
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor && !('value' in descriptor)) throw new Error();
	return descriptor?.value;
}

function text(value: unknown, max: number): string {
	if (typeof value !== 'string' || value.length > max) throw new Error();
	return value;
}

/** Detach only supported, bounded fields before the first socket or ownership change. */
export function validatedDeviceInfo(value: unknown): DesktopDeviceInfoSnapshot {
	try {
		const rawId = text(
			own(value, 'id'),
			RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.identifier + 512,
		);
		const id = rawId.trim();
		if (!id || id.length > RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.identifier)
			throw new Error();
		const platform = own(value, 'platform');
		if (
			platform !== 'ios' &&
			platform !== 'android' &&
			platform !== 'web' &&
			platform !== 'simulator' &&
			platform !== 'unknown'
		)
			throw new Error();
		const safeText = (input: unknown) =>
			truncateText(
				redactDiagnosticText(
					text(input, RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.short),
				),
				RNDEVTOOLS_SNAPSHOT_TEXT_LIMITS.short,
			).text;
		const capabilities = own(value, 'capabilities') ?? [];
		if (
			!Array.isArray(capabilities) ||
			capabilities.length > RNDEVTOOLS_ACTION_CAPABILITIES.length
		)
			throw new Error();
		const output: DesktopDeviceInfoSnapshot = {
			id,
			name: safeText(own(value, 'name')),
			platform,
			capabilities: [],
		};
		const declared: DesktopDeviceInfoSnapshot['capabilities'][number][] = [];
		for (let i = 0; i < capabilities.length; i++) {
			const descriptor = Object.getOwnPropertyDescriptor(
				capabilities,
				String(i),
			);
			if (
				!descriptor ||
				!('value' in descriptor) ||
				!RNDEVTOOLS_ACTION_CAPABILITIES.includes(descriptor.value)
			)
				throw new Error();
			declared.push(descriptor.value);
		}
		output.capabilities = declared;
		for (const key of [
			'model',
			'osVersion',
			'appVersion',
			'buildVersion',
			'runtimeVersion',
			'variant',
		] as const) {
			const input = own(value, key);
			if (input !== undefined) output[key] = safeText(input);
		}
		const bundleIdentifier = own(value, 'bundleIdentifier');
		if (bundleIdentifier !== undefined) {
			const bundle = text(bundleIdentifier, 255).trim();
			if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(bundle)) throw new Error();
			output.bundleIdentifier = bundle;
		}
		const simulatorUdid = own(value, 'simulatorUdid');
		if (simulatorUdid !== undefined) {
			const udid = text(simulatorUdid, 36);
			if (
				!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
					udid,
				)
			)
				throw new Error();
			output.simulatorUdid = udid;
		}
		const processId = own(value, 'processId');
		if (processId !== undefined) {
			if (
				typeof processId !== 'number' ||
				!Number.isInteger(processId) ||
				processId <= 0 ||
				processId > 2_147_483_647
			)
				throw new Error();
			output.processId = processId;
		}
		const viewport = own(value, 'viewport');
		if (viewport !== undefined) {
			const width = own(viewport, 'width');
			const height = own(viewport, 'height');
			if (
				typeof width !== 'number' ||
				!Number.isFinite(width) ||
				width <= 0 ||
				typeof height !== 'number' ||
				!Number.isFinite(height) ||
				height <= 0
			)
				throw new Error();
			output.viewport = { width, height };
		}
		return output;
	} catch {
		// Never include host values or accessor exceptions in the error.
		throw new Error(
			'Invalid desktop device info: supply bounded plain fields matching the desktop protocol.',
		);
	}
}
