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
});
