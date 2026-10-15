import { describe, expect, it } from 'vitest';
import { pointerToRatio } from './controllable-screen';

describe('pointerToRatio', () => {
	const frame = { left: 100, top: 50, width: 300, height: 650 };

	it('maps a pointer inside the rendered frame to 0…1 ratios of the device screen', () => {
		expect(pointerToRatio(frame, 100, 50)).toEqual({ x: 0, y: 0 });
		expect(pointerToRatio(frame, 400, 700)).toEqual({ x: 1, y: 1 });
		expect(pointerToRatio(frame, 250, 375)).toEqual({ x: 0.5, y: 0.5 });
		// Rounded to four places so an agent reading the log sees stable numbers.
		expect(pointerToRatio(frame, 100 + 100 / 3, 50)).toEqual({
			// 33.3 px of 300
			x: 0.1111,
			y: 0,
		});
	});

	it('ignores pointers in the letterbox outside the frame and degenerate frames', () => {
		expect(pointerToRatio(frame, 99, 300)).toBeUndefined();
		expect(pointerToRatio(frame, 250, 701)).toBeUndefined();
		expect(pointerToRatio({ ...frame, width: 0 }, 100, 50)).toBeUndefined();
	});
});
