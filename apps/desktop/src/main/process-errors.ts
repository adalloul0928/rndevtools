import {
	closeSync,
	constants,
	fchmodSync,
	fstatSync,
	ftruncateSync,
	mkdirSync,
	openSync,
	writeSync,
} from 'node:fs';
import path from 'node:path';
import { diagnosticErrorText } from '@rndevtools/core/redact';
import { truncateText } from '@rndevtools/core/serialize';

type FatalEvent = 'uncaughtException' | 'unhandledRejection';
type ErrorSource = {
	on: (event: FatalEvent, listener: (reason: unknown) => void) => unknown;
	removeListener: (
		event: FatalEvent,
		listener: (reason: unknown) => void
	) => unknown;
};

const MAX_LOG_BYTES = 64 * 1024;

/** Record one bounded, redacted failure before exiting an unsafe main process. */
export function installProcessErrorHandlers(
	options: { logPath: () => string; exit: (code: number) => void },
	source: ErrorSource = process
): () => void {
	let exiting = false;
	const fail = (event: FatalEvent, reason: unknown) => {
		if (exiting) return;
		exiting = true;
		try {
			const line = `${JSON.stringify({
				at: Date.now(),
				event,
				error: truncateText(diagnosticErrorText(reason), 4096).text,
			})}\n`;
			const file = options.logPath();
			mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			const fd = openSync(
				file,
				constants.O_WRONLY |
					constants.O_CREAT |
					constants.O_APPEND |
					constants.O_NOFOLLOW,
				0o600
			);
			try {
				const stat = fstatSync(fd);
				if (!stat.isFile()) throw new Error('Diagnostic log is not a file.');
				fchmodSync(fd, 0o600);
				if (stat.size + Buffer.byteLength(line) > MAX_LOG_BYTES)
					ftruncateSync(fd, 0);
				writeSync(fd, line);
			} finally {
				closeSync(fd);
			}
		} catch {
			// Logging must not recurse, leak the raw error, or prevent termination.
		} finally {
			options.exit(1);
		}
	};
	const exception = (reason: unknown) => fail('uncaughtException', reason);
	const rejection = (reason: unknown) => fail('unhandledRejection', reason);
	source.on('uncaughtException', exception);
	source.on('unhandledRejection', rejection);
	return () => {
		source.removeListener('uncaughtException', exception);
		source.removeListener('unhandledRejection', rejection);
	};
}
