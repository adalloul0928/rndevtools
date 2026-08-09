import { Alert } from 'react-native';
import { createActionServices } from './action-services';

describe('createActionServices', () => {
	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('audits successful actions', async () => {
		jest.spyOn(Date, 'now').mockReturnValue(1234);
		const action = jest.fn();
		const onAuditEvent = jest.fn();
		const services = createActionServices({ onAuditEvent });

		await expect(
			services.run({ pluginId: 'query', label: 'Refetch', action }),
		).resolves.toBe(true);

		expect(action).toHaveBeenCalledTimes(1);
		expect(onAuditEvent.mock.calls).toEqual([
			[
				{
					at: 1234,
					pluginId: 'query',
					label: 'Refetch',
					status: 'started',
				},
			],
			[
				{
					at: 1234,
					pluginId: 'query',
					label: 'Refetch',
					status: 'succeeded',
				},
			],
		]);
	});

	it('does not run a cancelled confirmed action', async () => {
		const action = jest.fn();
		const onAuditEvent = jest.fn();
		jest
			.spyOn(Alert, 'alert')
			.mockImplementation((_title, _message, buttons) => {
				buttons?.[0]?.onPress?.();
			});
		const services = createActionServices({ onAuditEvent });

		await expect(
			services.run({
				pluginId: 'storage',
				label: 'Clear',
				confirmation: {
					title: 'Clear storage?',
					destructive: true,
				},
				action,
			}),
		).resolves.toBe(false);

		expect(action).not.toHaveBeenCalled();
		expect(onAuditEvent).toHaveBeenCalledWith(
			expect.objectContaining({ status: 'cancelled' }),
		);
	});

	it('routes failures, shows a useful alert, and audits the error', async () => {
		const error = new Error('database unavailable');
		const onError = jest.fn();
		const onAuditEvent = jest.fn();
		const alert = jest.spyOn(Alert, 'alert').mockImplementation();
		const services = createActionServices({ onError, onAuditEvent });

		await expect(
			services.run({
				pluginId: 'database',
				label: 'Refresh database',
				action: () => {
					throw error;
				},
			}),
		).resolves.toBe(false);

		expect(onError).toHaveBeenCalledWith(error, 'database');
		expect(alert).toHaveBeenCalledWith(
			'Refresh database failed',
			'database unavailable',
		);
		expect(onAuditEvent).toHaveBeenLastCalledWith(
			expect.objectContaining({
				status: 'failed',
				error: 'database unavailable',
			}),
		);
	});
});
