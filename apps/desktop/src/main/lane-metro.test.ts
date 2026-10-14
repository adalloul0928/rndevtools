import { describe, expect, it } from 'vitest';
import { isLaneMetroCommand } from './lane-metro';

describe('isLaneMetroCommand', () => {
	it('recognises the Metro a lane started by its --port argument, wherever the binary lives', () => {
		expect(
			isLaneMetroCommand(
				'node /Users/dev/app/node_modules/.bin/expo start --dev-client --localhost --port 8100 --max-workers 2',
				8_100
			)
		).toBe(true);
		// pnpm hoists the binary to the workspace root; the cwd is not on the command line.
		expect(
			isLaneMetroCommand(
				'node /Users/dev/monorepo/node_modules/.bin/expo start --dev-client --localhost --port 8100 --max-workers 2',
				8_100
			)
		).toBe(true);
		expect(isLaneMetroCommand('node expo start --port=8100', 8_100)).toBe(true);
	});

	it("refuses a reused PID that is not this lane's Metro", () => {
		expect(isLaneMetroCommand('node expo start --port 8101', 8_100)).toBe(
			false
		);
		expect(isLaneMetroCommand('node expo start --port 81000', 8_100)).toBe(
			false
		);
		expect(isLaneMetroCommand('/usr/bin/ssh -p 8100 host', 8_100)).toBe(false);
		expect(isLaneMetroCommand('postgres --port 8100', 8_100)).toBe(false);
		expect(isLaneMetroCommand('', 8_100)).toBe(false);
	});
});
