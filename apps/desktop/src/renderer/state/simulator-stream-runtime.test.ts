import { describe, expect, it } from 'vitest';
import { resolveStreamSubscriptions } from './simulator-stream-runtime';

const A = 'AAAAAAAA-0000-4000-8000-000000000001';
const B = 'BBBBBBBB-0000-4000-8000-000000000002';

describe('resolveStreamSubscriptions', () => {
	it('collapses many component requests into one subscription per Simulator', () => {
		expect(
			resolveStreamSubscriptions([
				{ udid: A, quality: 'tile' },
				{ udid: A.toLowerCase(), quality: 'tile' },
				{ udid: B, quality: 'tile' },
			])
		).toEqual([
			{ udid: A, quality: 'tile' },
			{ udid: B, quality: 'tile' },
		]);
	});

	it('lets a focus request win over tile requests for the same Simulator', () => {
		expect(
			resolveStreamSubscriptions([
				{ udid: A, quality: 'tile' },
				{ udid: A, quality: 'focus' },
				{ udid: A, quality: 'tile' },
			])
		).toEqual([{ udid: A, quality: 'focus' }]);
	});

	it('returns a stable, sorted order so unchanged sets serialize identically', () => {
		const first = resolveStreamSubscriptions([
			{ udid: B, quality: 'tile' },
			{ udid: A, quality: 'focus' },
		]);
		const second = resolveStreamSubscriptions([
			{ udid: A, quality: 'focus' },
			{ udid: B, quality: 'tile' },
		]);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(resolveStreamSubscriptions([])).toEqual([]);
	});
});
