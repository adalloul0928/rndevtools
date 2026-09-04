import { describe, expect, it } from 'vitest';
import { runSimulatorCommand, SimulatorCommandError } from './simulator-command-runner';

describe('simulator command runner', () => {
	it('requires an absolute executable and preserves literal arguments', async () => {
		await expect(runSimulatorCommand('node', [])).rejects.toMatchObject({
			kind: 'spawn',
		});
		const payload = '; rm -rf / $(not-a-command)';
		const result = await runSimulatorCommand(process.execPath, [
			'-e',
			'process.stdout.write(process.argv[1])',
			payload,
		]);
		expect(result.stdout).toBe(payload);
	});

	it('bounds combined output', async () => {
		await expect(
			runSimulatorCommand(
				process.execPath,
				['-e', "process.stdout.write('x'.repeat(4096))"],
				{ maxOutputBytes: 128 }
			)
		).rejects.toMatchObject({ kind: 'output-limit' });
	});

	it('times out and cancels commands', async () => {
		await expect(
			runSimulatorCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
				timeoutMs: 25,
			})
		).rejects.toMatchObject({ kind: 'timeout' });

		const controller = new AbortController();
		const command = runSimulatorCommand(
			process.execPath,
			['-e', 'setInterval(() => {}, 1000)'],
			{ signal: controller.signal }
		);
		controller.abort();
		await expect(command).rejects.toMatchObject({ kind: 'aborted' });
	});

	it('requests helper cleanup through the private control pipe before force kill', async () => {
		let failure: unknown;
		try {
			await runSimulatorCommand(
				process.execPath,
				[
					'-e',
					"const fs=require('node:fs'); const b=Buffer.alloc(1); fs.read(4,b,0,1,null,()=>{process.stdout.write('control-closed');process.exit(0)}); setInterval(()=>{},1000)",
				],
				{
					timeoutMs: 25,
					forceKillDelayMs: 1_000,
					gracefulCancellationPipe: true,
				}
			);
		} catch (error) {
			failure = error;
		}
		expect(failure).toMatchObject({
			kind: 'timeout',
			stdout: 'control-closed',
		});
	});

	it('returns bounded failure details without including arguments in its message', async () => {
		const secretArgument = 'private-token-value';
		let failure: unknown;
		try {
			await runSimulatorCommand(process.execPath, [
				'-e',
				'process.stderr.write(process.argv[1]); process.exit(7)',
				secretArgument,
			]);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SimulatorCommandError);
		expect(failure).toMatchObject({ exitCode: 7, kind: 'failed' });
		expect((failure as Error).message).not.toContain(secretArgument);
	});

	it('normalizes synchronous spawn validation failures without echoing arguments', async () => {
		const secretArgument = 'private\0token';
		let failure: unknown;
		try {
			await runSimulatorCommand(process.execPath, [secretArgument]);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(SimulatorCommandError);
		expect(failure).toMatchObject({ kind: 'spawn' });
		expect((failure as Error).message).not.toContain('private');
	});

	it('uses a minimal environment and strips secrets and SIMCTL_CHILD overrides', async () => {
		const previousSecret = process.env.PUMPD_TEST_SECRET;
		const previousChildOverride = process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES;
		process.env.PUMPD_TEST_SECRET = 'must-not-be-inherited';
		process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES = '/tmp/untrusted.dylib';
		try {
			const result = await runSimulatorCommand(process.execPath, [
				'-e',
				'process.stdout.write(JSON.stringify(process.env))',
			]);
			const environment = JSON.parse(result.stdout) as Record<string, string>;
			expect(environment.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
			expect(environment.PUMPD_TEST_SECRET).toBeUndefined();
			expect(environment.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES).toBeUndefined();
		} finally {
			if (previousSecret === undefined) delete process.env.PUMPD_TEST_SECRET;
			else process.env.PUMPD_TEST_SECRET = previousSecret;
			if (previousChildOverride === undefined) {
				delete process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES;
			} else {
				process.env.SIMCTL_CHILD_DYLD_INSERT_LIBRARIES = previousChildOverride;
			}
		}
	});

	it('sets only typed allowlisted app environment controls', async () => {
		const result = await runSimulatorCommand(
			process.execPath,
			['-e', 'process.stdout.write(JSON.stringify(process.env))'],
			{
				simulatorAppEnvironment: {
					timeZone: 'America/Los_Angeles',
					slowAnimations: true,
				},
			}
		);
		const environment = JSON.parse(result.stdout) as Record<string, string>;
		expect(environment.SIMCTL_CHILD_TZ).toBe('America/Los_Angeles');
		expect(environment.SIMCTL_CHILD_PUMPD_SLOW_ANIMATIONS).toBe('1');
		expect(
			Object.keys(environment)
				.filter((key) => key.startsWith('SIMCTL_CHILD_'))
				.sort()
		).toEqual(['SIMCTL_CHILD_PUMPD_SLOW_ANIMATIONS', 'SIMCTL_CHILD_TZ']);
		await expect(
			runSimulatorCommand(process.execPath, ['-e', 'process.exit(0)'], {
				simulatorAppEnvironment: { timeZone: '../../private/etc' },
			})
		).rejects.toMatchObject({ kind: 'spawn' });
	});
});
