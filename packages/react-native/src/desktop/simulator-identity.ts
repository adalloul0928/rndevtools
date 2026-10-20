/**
 * Simulator identity for the desktop.
 *
 * The desktop addresses Simulators by CoreSimulator UDID, and so do coding
 * agents (`rndevtools --udid`). An app running inside a Simulator can learn
 * its own UDID without any private API: every container path it is given
 * lives under `.../CoreSimulator/Devices/<UDID>/data/...`. The host passes a
 * path it already has (documents, caches, the bundle) and gets the UDID back,
 * so one identifier links the Simulator row, the connected app session, and
 * the lane that started it.
 */

const SIMULATOR_DEVICE_PATH =
	/\/CoreSimulator\/Devices\/([0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12})\//i;

/**
 * Extracts the Simulator UDID from a container path or `file://` URI. Returns
 * `undefined` on a physical device, on Android, or for any path that does not
 * come from a CoreSimulator device set.
 */
export function simulatorUdidFromPath(
	pathOrUri: string | null | undefined,
): string | undefined {
	if (!pathOrUri || pathOrUri.length > 4_096) return undefined;
	let decoded = pathOrUri;
	try {
		decoded = decodeURIComponent(pathOrUri);
	} catch {
		// A path with a stray percent sign is still worth matching verbatim.
	}
	const match = SIMULATOR_DEVICE_PATH.exec(decoded);
	return match?.[1]?.toUpperCase();
}
