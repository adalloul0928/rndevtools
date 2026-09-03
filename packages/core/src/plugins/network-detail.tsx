import {
	Button,
	DisclosureGroup,
	Host,
	LabeledContent,
	List,
	Section,
	Text as UIText,
	VStack,
} from '@expo/ui/swift-ui';
import {
	font,
	foregroundStyle,
	listStyle,
	textSelection,
} from '@expo/ui/swift-ui/modifiers';
import { useMemo } from 'react';
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSection,
	AndroidPanelTextBlock,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import { serializeValue, truncateText } from '../core/serialize';
import { shareDiagnosticContent } from '../core/share';
import type { DevToolsActionServices } from '../types';
import {
	formatNetworkBytes,
	type NetworkEvent,
	parseNetworkUrl,
} from './network-capture';

import {
	buildCurlCommand,
	detailStatusText,
	formatNetworkClock,
	formatNetworkDuration,
	MAX_BODY_PREVIEW_BYTES,
	MUTATING_METHODS,
	type NetworkStatusTone,
	networkEventLabel,
	networkReplayBlockReason,
	networkRequestPath,
	networkStatusPresentation,
	prettyNetworkBody,
	responseBodySummaryText,
} from './network-presentation';

export function statusColor(tone: NetworkStatusTone) {
	if (tone === 'success') return PlatformColor('systemGreenColor');
	if (tone === 'danger') return PlatformColor('systemRedColor');
	if (tone === 'warning') return PlatformColor('systemOrangeColor');
	return PlatformColor('systemBlueColor');
}

const monoSmall = () => font({ design: 'monospaced', size: 12 });
export const secondarySmall = () => [
	font({ size: 13 }),
	foregroundStyle(PlatformColor('secondaryLabelColor')),
];

function HeaderRows({
	entries,
}: {
	entries: ReadonlyArray<readonly [string, string]>;
}) {
	return (
		<>
			{entries.map(([name, value]) => (
				<LabeledContent key={name} label={name}>
					<UIText modifiers={[monoSmall()]}>{value}</UIText>
				</LabeledContent>
			))}
		</>
	);
}

export function NetworkEventDetail({
	actions,
	event,
	listTitle,
	maxBodyBytes,
	onBack,
	pluginId,
}: {
	actions: DevToolsActionServices;
	event: NetworkEvent;
	listTitle: string;
	maxBodyBytes: number;
	onBack: () => void;
	pluginId: string;
}) {
	const { label } = networkEventLabel(event);
	const status = networkStatusPresentation(event);
	const path = networkRequestPath(event.url);
	const requestHeaderEntries = Object.entries(event.requestHeaders);
	const responseHeaderEntries = Object.entries(event.responseHeaders ?? {});
	const replayBlockReason = networkReplayBlockReason(event);
	// Pretty-printing can chew through 256 KB bodies; cache per event so live
	// capture ticks don't re-parse while the detail is open.
	const requestBody = useMemo(
		() =>
			event.requestBody === undefined
				? undefined
				: truncateText(
						prettyNetworkBody(event.requestBody),
						MAX_BODY_PREVIEW_BYTES,
					).text,
		[event],
	);
	const responseBody = useMemo(
		() =>
			event.responseBody === undefined
				? undefined
				: truncateText(
						prettyNetworkBody(event.responseBody),
						MAX_BODY_PREVIEW_BYTES,
					).text,
		[event],
	);
	const shareEvent = () => {
		shareDiagnosticContent({
			title: `${event.method} ${path}`,
			message: serializeValue(event, 512 * 1024).text,
		});
	};
	// expo-clipboard is not a dependency; the share sheet's Copy action is the
	// sanctioned way to get text onto the pasteboard from here.
	const copyCurl = () => {
		shareDiagnosticContent({ message: buildCurlCommand(event) });
	};
	const resendRequest = () => {
		if (replayBlockReason) return;
		const headers = Object.fromEntries(requestHeaderEntries);
		void actions.run({
			pluginId,
			label: 'Re-send request',
			confirmation: {
				title: 'Re-send this request?',
				message: `A real ${event.method} goes to ${parseNetworkUrl(event.url).host}. The request has no detected redaction placeholders, but the response can still differ from the captured one.`,
				confirmLabel: 'Re-send',
				destructive: MUTATING_METHODS.has(event.method),
			},
			action: async () => {
				const init: RequestInit = { method: event.method, headers };
				if (
					event.requestBody !== undefined &&
					event.method !== 'GET' &&
					event.method !== 'HEAD'
				) {
					init.body = event.requestBody;
				}
				// The instrumented global fetch captures the replay as a new event.
				await globalThis.fetch(event.url, init);
			},
		});
	};

	return (
		<PanelShell
			backLabel={listTitle}
			onBack={onBack}
			title={`${event.method} ${label}`}
			trailing={
				<NavIconButton
					accessibilityLabel="Share request"
					onPress={shareEvent}
					systemImage="square.and.arrow.up"
					testID="devtools-network-share"
				/>
			}
		>
			{Platform.OS === 'ios' ? (
				<Host style={{ flex: 1 }}>
					<List modifiers={[listStyle('insetGrouped')]}>
						<Section title="Overview">
							<LabeledContent label="Status">
								<UIText
									modifiers={[
										font({ design: 'monospaced', weight: 'semibold' }),
										foregroundStyle(statusColor(status.tone)),
									]}
								>
									{detailStatusText(event)}
								</UIText>
							</LabeledContent>
							<LabeledContent label="Duration">
								<UIText>
									{event.state === 'pending'
										? 'Pending'
										: formatNetworkDuration(event.durationMs)}
								</UIText>
							</LabeledContent>
							<LabeledContent label="Started">
								<UIText>{formatNetworkClock(event.startedAt)}</UIText>
							</LabeledContent>
							<LabeledContent label="Size">
								<UIText>{`↑ ${formatNetworkBytes(event.requestSizeBytes)} · ↓ ${formatNetworkBytes(event.responseSizeBytes)}`}</UIText>
							</LabeledContent>
							<LabeledContent label="Source">
								<UIText>{event.source}</UIText>
							</LabeledContent>
							{event.error ? (
								<LabeledContent label="Error">
									<UIText
										modifiers={[
											foregroundStyle(PlatformColor('systemRedColor')),
										]}
									>
										{event.error}
									</UIText>
								</LabeledContent>
							) : null}
						</Section>
						<Section title="Request">
							<VStack alignment="leading" spacing={3}>
								<UIText modifiers={secondarySmall()}>URL</UIText>
								<UIText modifiers={[monoSmall(), textSelection(true)]}>
									{path}
								</UIText>
							</VStack>
							<DisclosureGroup
								label={`Headers (${requestHeaderEntries.length})`}
							>
								<HeaderRows entries={requestHeaderEntries} />
							</DisclosureGroup>
							<LabeledContent label="Body">
								<UIText>
									{event.requestBody === undefined
										? 'Empty'
										: formatNetworkBytes(event.requestSizeBytes)}
								</UIText>
							</LabeledContent>
							{requestBody !== undefined ? (
								<UIText modifiers={[monoSmall(), textSelection(true)]}>
									{requestBody}
								</UIText>
							) : null}
						</Section>
						<Section
							footer={
								<UIText>
									{`Bodies over ${Math.round(maxBodyBytes / 1024)} KB are truncated at capture time.`}
								</UIText>
							}
							title="Response"
						>
							{responseHeaderEntries.length > 0 ? (
								<DisclosureGroup
									label={`Headers (${responseHeaderEntries.length})`}
								>
									<HeaderRows entries={responseHeaderEntries} />
								</DisclosureGroup>
							) : null}
							<LabeledContent label="Body">
								<UIText>{responseBodySummaryText(event)}</UIText>
							</LabeledContent>
							{responseBody !== undefined ? (
								<UIText modifiers={[monoSmall(), textSelection(true)]}>
									{responseBody}
								</UIText>
							) : null}
						</Section>
						<Section>
							<Button
								label="Copy as cURL"
								onPress={copyCurl}
								testID="devtools-network-copy-curl"
							/>
							{replayBlockReason ? (
								<UIText modifiers={secondarySmall()}>
									{`Re-send unavailable: ${replayBlockReason}`}
								</UIText>
							) : (
								<Button
									label="Re-send request"
									onPress={resendRequest}
									testID="devtools-network-resend"
								/>
							)}
							<Button
								label="Share…"
								onPress={shareEvent}
								testID="devtools-network-share-action"
							/>
						</Section>
					</List>
				</Host>
			) : (
				<AndroidPanelScroll>
					<AndroidPanelSection title="Overview">
						<AndroidPanelRow label="Status" value={detailStatusText(event)} />
						<AndroidPanelRow
							label="Duration"
							value={
								event.state === 'pending'
									? 'Pending'
									: formatNetworkDuration(event.durationMs)
							}
						/>
						<AndroidPanelRow
							label="Started"
							value={formatNetworkClock(event.startedAt)}
						/>
						<AndroidPanelRow
							label="Size"
							value={`↑ ${formatNetworkBytes(event.requestSizeBytes)} · ↓ ${formatNetworkBytes(event.responseSizeBytes)}`}
						/>
						<AndroidPanelRow label="Source" value={event.source} />
						{event.error ? (
							<AndroidPanelTextBlock
								label="Error"
								tone="danger"
								value={event.error}
							/>
						) : null}
					</AndroidPanelSection>
					<AndroidPanelSection title="Request">
						<AndroidPanelTextBlock label="URL" value={path} />
						<AndroidPanelRow
							label="Headers"
							value={String(requestHeaderEntries.length)}
						/>
						{requestHeaderEntries.map(([name, value]) => (
							<AndroidPanelTextBlock key={name} label={name} value={value} />
						))}
						<AndroidPanelRow
							label="Body"
							value={
								event.requestBody === undefined
									? 'Empty'
									: formatNetworkBytes(event.requestSizeBytes)
							}
						/>
						{requestBody !== undefined ? (
							<AndroidPanelTextBlock label="Payload" value={requestBody} />
						) : null}
					</AndroidPanelSection>
					<AndroidPanelSection
						title="Response"
						footer={`Bodies over ${Math.round(maxBodyBytes / 1024)} KB are truncated at capture time.`}
					>
						<AndroidPanelRow
							label="Headers"
							value={String(responseHeaderEntries.length)}
						/>
						{responseHeaderEntries.map(([name, value]) => (
							<AndroidPanelTextBlock key={name} label={name} value={value} />
						))}
						<AndroidPanelRow
							label="Body"
							value={responseBodySummaryText(event)}
						/>
						{responseBody !== undefined ? (
							<AndroidPanelTextBlock label="Payload" value={responseBody} />
						) : null}
					</AndroidPanelSection>
					<AndroidPanelSection title="Actions">
						<AndroidPanelRow label="Copy as cURL" onPress={copyCurl} />
						{replayBlockReason ? (
							<AndroidPanelTextBlock
								label="Re-send unavailable"
								value={replayBlockReason}
							/>
						) : (
							<AndroidPanelRow
								label="Re-send request"
								onPress={resendRequest}
							/>
						)}
						<AndroidPanelRow label="Share…" onPress={shareEvent} />
					</AndroidPanelSection>
				</AndroidPanelScroll>
			)}
		</PanelShell>
	);
}
