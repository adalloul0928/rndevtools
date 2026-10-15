import { Button } from '@heroui/react/button';
import { Bot, Link2, Link2Off, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { AgentGlyph } from '@/components/lane-ui';
import { Badge, Disclosure, KeyValue, PanelNotice } from '@/components/ui';
import { shortPath } from '@/simulator/fleet-model';
import { useAgentRuntime } from '@/state/agent-runtime';
import type {
	AgentSession,
	AgentState,
	DeviceAgent,
} from '../../../shared/agent-protocol';
import { agentSessionKey } from '../../../shared/agent-protocol';
import type { SimulatorDevice } from '../../../shared/simulator-protocol';

/**
 * Groups the per-device attachments by session, so the view answers "what is
 * this agent driving?" as well as "who is on this Simulator?". Sessions with
 * no device still appear: an idle agent is information too.
 */
export function sessionsWithDevices(
	state: Pick<AgentState, 'sessions' | 'byDevice'>
): Array<{
	session: AgentSession;
	devices: Array<{ udid: string; attachment: DeviceAgent }>;
}> {
	const byKey = new Map(
		state.sessions.map((session) => [
			agentSessionKey(session),
			{
				session,
				devices: [] as Array<{ udid: string; attachment: DeviceAgent }>,
			},
		])
	);
	for (const [udid, attachments] of Object.entries(state.byDevice)) {
		for (const attachment of attachments) {
			const key = agentSessionKey(attachment);
			const entry = byKey.get(key) ?? {
				session: attachment,
				devices: [],
			};
			entry.devices.push({ udid, attachment });
			byKey.set(key, entry);
		}
	}
	return [...byKey.values()].sort((left, right) => {
		if (left.devices.length !== right.devices.length) {
			return right.devices.length - left.devices.length;
		}
		return (right.session.updatedAt ?? 0) - (left.session.updatedAt ?? 0);
	});
}

function viaLabel(via: DeviceAgent['via']): string {
	switch (via) {
		case 'claim':
			return 'claimed';
		case 'touch':
			return 'driving';
		default:
			return 'lane cwd';
	}
}

export function AgentsView({
	devices,
	onSelectSimulator,
}: {
	devices: readonly SimulatorDevice[];
	onSelectSimulator: (udid: string) => void;
}) {
	const agents = useAgentRuntime();
	const deviceByUdid = useMemo(
		() => new Map(devices.map((device) => [device.udid.toUpperCase(), device])),
		[devices]
	);
	const rows = useMemo(() => sessionsWithDevices(agents.state), [agents.state]);
	const { discovery } = agents.state;

	return (
		<div className="agents-view panel-scroll">
			<div className="agents-toolbar">
				<p className="sim-inline-note">
					Live Claude Code and Codex sessions on this Mac and the Simulators
					each one is attached to. Attribution comes from explicit claims,
					recent CLI commands, and lanes whose app directory is the session’s
					working directory. Claims are a convention agents follow, not a lock.
				</p>
				<Button
					aria-label="Refresh agents"
					className="sim-icon-button"
					isDisabled={!agents.isBridgeAvailable}
					isIconOnly
					size="sm"
					variant="secondary"
					onPress={() => void agents.refresh()}
				>
					<RefreshCw className="h-3.5 w-3.5" />
				</Button>
			</div>
			{agents.error ? (
				<PanelNotice title="Agent state could not be read." tone="danger">
					{agents.error}
				</PanelNotice>
			) : null}
			{discovery.claude === 'unavailable' &&
			discovery.codex === 'unavailable' ? (
				<PanelNotice title="No agent registries found." tone="info">
					Claude Code sessions are read from <code>~/.claude/sessions</code> and
					Codex threads from <code>~/.codex</code>. Neither exists on this Mac,
					so only CLI touches and claims can attribute devices.
				</PanelNotice>
			) : null}
			{discovery.error ? (
				<PanelNotice
					title="Session discovery reported a problem."
					tone="warning"
				>
					{discovery.error}
				</PanelNotice>
			) : null}
			{rows.length === 0 ? (
				<div className="lane-empty">
					<Bot className="h-5 w-5" />
					<strong>No live agent sessions</strong>
					<span>
						Start Claude Code or Codex in a worktree, or run any{' '}
						<code>rndevtools</code> command from inside one, and it appears here
						with the Simulators it touches.
					</span>
				</div>
			) : (
				<ul className="agent-list">
					{rows.map(({ session, devices: attached }) => (
						<li key={agentSessionKey(session)} className="agent-card">
							<div className="agent-card-head">
								<AgentGlyph kind={session.kind} />
								<div className="agent-card-title">
									<strong className="agent-card-name">{session.title}</strong>
									<span className="agent-card-meta">
										{session.kind}
										{session.status ? ` · ${session.status}` : ''}
										{session.pid ? ` · pid ${session.pid}` : ''}
										{session.updatedAt
											? ` · ${new Date(session.updatedAt).toLocaleTimeString()}`
											: ''}
									</span>
								</div>
								<Badge tone={attached.length > 0 ? 'info' : 'default'}>
									{attached.length === 0
										? 'idle'
										: `${attached.length} device${attached.length === 1 ? '' : 's'}`}
								</Badge>
							</div>
							{session.cwd ? (
								<code className="agent-card-cwd" title={session.cwd}>
									{shortPath(session.cwd)}
								</code>
							) : null}
							{attached.length > 0 ? (
								<ul className="agent-devices">
									{attached.map(({ udid, attachment }) => {
										const device = deviceByUdid.get(udid.toUpperCase());
										return (
											<li key={udid} className="agent-device">
												<button
													type="button"
													className="agent-device-name"
													onClick={() => onSelectSimulator(udid)}
												>
													{device?.name ?? udid}
													{device ? (
														<span className="agent-device-state">
															{' '}
															· {device.state}
														</span>
													) : null}
												</button>
												<Badge
													tone={
														attachment.via === 'claim'
															? 'brand'
															: attachment.via === 'touch'
																? 'success'
																: 'default'
													}
												>
													{viaLabel(attachment.via)}
													{!attachment.live ? ' · session gone' : ''}
												</Badge>
												{attachment.note ? (
													<span className="agent-device-note">
														{attachment.note}
													</span>
												) : null}
												{attachment.via === 'claim' ? (
													<Button
														aria-label={`Release ${device?.name ?? udid}`}
														className="sim-icon-button"
														isIconOnly
														size="sm"
														variant="ghost"
														onPress={() =>
															void agents.runOperation({
																kind: 'agent.release',
																simulatorUdid: udid,
																agent: {
																	kind: attachment.kind,
																	sessionId: attachment.sessionId,
																},
															})
														}
													>
														<Link2Off className="h-3.5 w-3.5" />
													</Button>
												) : (
													<Button
														aria-label={`Claim ${device?.name ?? udid} for ${session.title}`}
														className="sim-icon-button"
														isIconOnly
														size="sm"
														variant="ghost"
														onPress={() =>
															void agents.runOperation({
																kind: 'agent.claim',
																simulatorUdid: udid,
																agent: {
																	kind: session.kind,
																	sessionId: session.sessionId,
																},
																note: 'Claimed from the desktop.',
															})
														}
													>
														<Link2 className="h-3.5 w-3.5" />
													</Button>
												)}
											</li>
										);
									})}
								</ul>
							) : null}
							<Disclosure title="Session details">
								<dl>
									<KeyValue label="Session id" mono value={session.sessionId} />
									{session.cwd ? (
										<KeyValue
											label="Working directory"
											mono
											value={session.cwd}
										/>
									) : null}
									{session.startedAt ? (
										<KeyValue
											label="Started"
											value={new Date(session.startedAt).toLocaleString()}
										/>
									) : null}
								</dl>
							</Disclosure>
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
