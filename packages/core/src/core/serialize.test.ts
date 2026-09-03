import { serializeValue, truncateText, utf8ByteLength } from './serialize';

describe('serializeValue', () => {
	it('serializes circular and bigint values safely', () => {
		const value: { count: bigint; self?: unknown } = { count: 2n };
		value.self = value;

		expect(serializeValue(value).text).toContain('[Circular]');
		expect(serializeValue(value).text).toContain('2n');
	});

	it('truncates to the requested approximate byte budget', () => {
		const result = serializeValue('abcdefghij', 10);

		expect(result.truncated).toBe(true);
		expect(result.estimatedBytes).toBe(10);
	});

	it('redacts and serializes without invoking accessors or toJSON hooks', () => {
		const getter = jest.fn(() => 'private-getter');
		const toJSON = jest.fn(() => ({ token: 'private-to-json' }));
		const value = { email: 'person@example.com', toJSON } as Record<
			string,
			unknown
		>;
		Object.defineProperty(value, 'unsafe', { enumerable: true, get: getter });

		const serialized = serializeValue(value).text;

		expect(serialized).toContain('[REDACTED]');
		expect(serialized).toContain('[Accessor omitted]');
		expect(serialized).not.toContain('person@example.com');
		expect(getter).not.toHaveBeenCalled();
		expect(toJSON).not.toHaveBeenCalled();
	});
});

describe('truncateText', () => {
	it('preserves raw strings without JSON quoting', () => {
		expect(truncateText('{"ok":true}').text).toBe('{"ok":true}');
	});

	it('enforces UTF-8 byte budgets for CJK and emoji without splitting surrogates', () => {
		const result = truncateText('训练🏋️abcdef', 12);

		expect(result.truncated).toBe(true);
		expect(utf8ByteLength(result.text)).toBeLessThanOrEqual(12);
		expect(result.text).not.toContain('\uFFFD');
	});

	it('preserves text that exactly fills very small byte budgets', () => {
		expect(truncateText('ab', 2)).toEqual({
			text: 'ab',
			truncated: false,
			estimatedBytes: 2,
		});
		expect(truncateText('abc', 2)).toEqual({
			text: '',
			truncated: true,
			estimatedBytes: 0,
		});
	});

	it('treats positive infinity as an unbounded byte budget', () => {
		expect(truncateText('unbounded', Number.POSITIVE_INFINITY)).toEqual({
			text: 'unbounded',
			truncated: false,
			estimatedBytes: 9,
		});
	});
});
