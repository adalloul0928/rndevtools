import { describe, expect, it } from 'vitest';
import { laneFocusRequest, resolveLaneFocus } from './lane-runtime';

const LANE = 'lane-c69dc564-b12e-45d5-b0d5-3e9d034a072d';
const OTHER = 'lane-d3c29403-e3a7-4bc9-ab44-93684dacbc56';

describe('laneFocusRequest', () => {
	it('reads a bare id as a lane, and keeps the Agents session key', () => {
		expect(laneFocusRequest(LANE, 1)).toEqual({
			view: 'lanes',
			laneId: LANE,
			nonce: 1,
		});
		expect(
			laneFocusRequest({ view: 'agents', sessionKey: 'claude:7f3a2c91' }, 2)
		).toEqual({ view: 'agents', sessionKey: 'claude:7f3a2c91', nonce: 2 });
		expect(laneFocusRequest({ view: 'agents' }, 3)).toEqual({
			view: 'agents',
			nonce: 3,
		});
		expect(laneFocusRequest({ view: 'lanes' }, 4)).toEqual({
			view: 'lanes',
			nonce: 4,
		});
	});
});

describe('resolveLaneFocus', () => {
	const lanes = [{ id: OTHER }, { id: LANE }];

	it('selects a listed lane, not the first one', () => {
		expect(resolveLaneFocus(laneFocusRequest(LANE, 1), lanes, false)).toEqual({
			kind: 'apply',
			view: 'lanes',
			laneId: LANE,
		});
	});

	it('waits for the first lane state, then falls back to the default selection', () => {
		expect(resolveLaneFocus(laneFocusRequest(LANE, 1), [], true)).toEqual({
			kind: 'wait',
		});
		expect(resolveLaneFocus(laneFocusRequest(LANE, 1), [], false)).toEqual({
			kind: 'apply',
			view: 'lanes',
		});
		expect(
			resolveLaneFocus(laneFocusRequest(LANE, 1), [{ id: OTHER }], false)
		).toEqual({ kind: 'apply', view: 'lanes' });
	});

	it('opens the Agents view at once, at a session when one is named', () => {
		expect(
			resolveLaneFocus(
				laneFocusRequest({ view: 'agents', sessionKey: 'codex:3c9e7a12' }, 1),
				[],
				true
			)
		).toEqual({ kind: 'apply', view: 'agents', sessionKey: 'codex:3c9e7a12' });
	});
});
