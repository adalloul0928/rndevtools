import { describe, expect, it } from 'vitest';
import { boundedTextExport } from './format';

describe('boundedTextExport', () => {
	it('joins entries without changing an export inside the limit', () => {
		expect(boundedTextExport(['one', 'two'], (value) => value, 100)).toEqual({
			text: 'one\n\ntwo',
			truncated: false,
		});
	});

	it('never exceeds the requested limit and marks truncation', () => {
		const result = boundedTextExport(['a'.repeat(80)], (value) => value, 64);
		expect(result.truncated).toBe(true);
		expect(result.text).toHaveLength(64);
		expect(result.text).toContain('[Export truncated');
	});
});
