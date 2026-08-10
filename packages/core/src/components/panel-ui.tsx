import {
	Children,
	type PropsWithChildren,
	type ReactElement,
	type ReactNode,
	useState,
} from 'react';
import {
	type ColorValue,
	type FlatListProps,
	PlatformColor,
	StyleSheet,
	Text,
	View,
} from 'react-native';
import { FlatList, RectButton } from 'react-native-gesture-handler';
import type { DevToolsPanelProps, DevToolsSystemImage } from '../types';
import { SystemIcon } from './system-icon';

export const colors = {
	background: PlatformColor('systemGroupedBackgroundColor'),
	card: PlatformColor('secondarySystemGroupedBackgroundColor'),
	label: PlatformColor('labelColor'),
	secondaryLabel: PlatformColor('secondaryLabelColor'),
	separator: PlatformColor('separatorColor'),
	blue: PlatformColor('systemBlueColor'),
	green: PlatformColor('systemGreenColor'),
	orange: PlatformColor('systemOrangeColor'),
	red: PlatformColor('systemRedColor'),
	// `whiteColor` is not a dependable named platform color on every iOS
	// runtime. iOS 26 can resolve it transparently inside gesture-handler
	// buttons, which makes selected segment labels disappear.
	onAccent: '#FFFFFF',
	shadow: PlatformColor('blackColor'),
} as const;

type PanelScaffoldProps = PropsWithChildren<
	Pick<DevToolsPanelProps, 'onBack'> & {
		title: string;
		subtitle?: string;
		rightAccessory?: ReactNode;
		scrollable?: boolean;
	}
>;

export function PanelScaffold({
	title,
	subtitle,
	onBack,
	rightAccessory,
	children,
	scrollable = true,
}: PanelScaffoldProps) {
	const rows = Children.toArray(children);
	return (
		<View style={styles.screen}>
			<View style={styles.header}>
				<RectButton
					onPress={onBack}
					accessibilityLabel="All tools"
					accessibilityRole="button"
					style={styles.backButton}
				>
					<SystemIcon systemName="chevron.left" size={17} />
				</RectButton>
				<View style={styles.headerCopy}>
					<Text style={styles.title}>{title}</Text>
					{subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
				</View>
				<View style={styles.headerAccessory}>{rightAccessory}</View>
			</View>
			{scrollable ? (
				<FlatList
					contentContainerStyle={styles.content}
					data={rows}
					ItemSeparatorComponent={PanelListSeparator}
					keyExtractor={(item, index) =>
						typeof item === 'object' && item && 'key' in item && item.key
							? String(item.key)
							: String(index)
					}
					renderItem={({ item }) => <>{item}</>}
					showsVerticalScrollIndicator={false}
				/>
			) : (
				children
			)}
		</View>
	);
}

type PanelListProps<T> = Pick<
	FlatListProps<T>,
	'data' | 'keyExtractor' | 'renderItem'
> & {
	header?: ReactNode;
	empty?: ReactNode;
};

export function PanelList<T>({
	data,
	keyExtractor,
	renderItem,
	header,
	empty,
}: PanelListProps<T>): ReactElement {
	return (
		<FlatList
			contentContainerStyle={styles.content}
			data={data}
			ItemSeparatorComponent={PanelListSeparator}
			keyExtractor={keyExtractor}
			ListEmptyComponent={empty ? <View>{empty}</View> : null}
			ListHeaderComponent={
				header ? <View style={styles.listHeader}>{header}</View> : null
			}
			renderItem={renderItem}
			showsVerticalScrollIndicator={false}
		/>
	);
}

export type PanelMetric = {
	label: string;
	value: string | number;
	tone?: ColorValue;
};

export type PanelTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

function toneColor(tone: PanelTone): ColorValue {
	if (tone === 'success') return colors.green;
	if (tone === 'warning') return colors.orange;
	if (tone === 'danger') return colors.red;
	if (tone === 'info') return colors.blue;
	return colors.secondaryLabel;
}

export function PanelSignalCard({
	systemImage,
	eyebrow,
	title,
	description,
	tone = 'neutral',
}: {
	systemImage: DevToolsSystemImage;
	eyebrow: string;
	title: string;
	description: string;
	tone?: PanelTone;
}) {
	const accent = toneColor(tone);
	return (
		<View style={styles.signalCard}>
			<View style={styles.signalIcon}>
				<SystemIcon systemName={systemImage} size={22} color={accent} />
			</View>
			<View style={styles.signalCopy}>
				<Text style={[styles.signalEyebrow, { color: accent }]}>{eyebrow}</Text>
				<Text style={styles.signalTitle}>{title}</Text>
				<Text style={styles.signalDescription}>{description}</Text>
			</View>
		</View>
	);
}

export function PanelStatusBadge({
	label,
	tone = 'neutral',
}: {
	label: string;
	tone?: PanelTone;
}) {
	const accent = toneColor(tone);
	return (
		<View style={[styles.statusBadge, { borderColor: accent }]}>
			<Text style={[styles.statusBadgeText, { color: accent }]}>{label}</Text>
		</View>
	);
}

export function PanelMetricStrip({
	metrics,
}: {
	metrics: readonly PanelMetric[];
}) {
	return (
		<View style={styles.metricStrip}>
			{metrics.map((metric, index) => (
				<View
					key={metric.label}
					style={[styles.metric, index > 0 && styles.metricDivider]}
				>
					<Text
						style={[styles.metricValue, { color: metric.tone ?? colors.label }]}
					>
						{metric.value}
					</Text>
					<Text numberOfLines={1} style={styles.metricLabel}>
						{metric.label}
					</Text>
				</View>
			))}
		</View>
	);
}

function PanelListSeparator() {
	return <View style={styles.listSeparator} />;
}

type DisclosureCardProps = PropsWithChildren<{
	title: string;
	subtitle?: string;
	leading?: ReactNode;
	renderDetails?: () => ReactNode;
}>;

export function DisclosureCard({
	title,
	subtitle,
	leading,
	children,
	renderDetails,
}: DisclosureCardProps) {
	const [expanded, setExpanded] = useState(false);

	return (
		<View style={styles.card}>
			<RectButton
				onPress={() => setExpanded((current) => !current)}
				accessibilityLabel={[title, subtitle].filter(Boolean).join(', ')}
				accessibilityRole="button"
				accessibilityState={{ expanded }}
				style={styles.cardButton}
			>
				{leading}
				<View style={styles.cardCopy}>
					<Text numberOfLines={1} style={styles.cardTitle}>
						{title}
					</Text>
					{subtitle ? (
						<Text numberOfLines={2} style={styles.cardSubtitle}>
							{subtitle}
						</Text>
					) : null}
				</View>
				<SystemIcon
					systemName={expanded ? 'chevron.down' : 'chevron.right'}
					size={13}
					color={colors.secondaryLabel}
				/>
			</RectButton>
			{expanded ? (
				<View style={styles.details}>{renderDetails?.() ?? children}</View>
			) : null}
		</View>
	);
}

export function CodeBlock({ children }: { children: string }) {
	return (
		<Text selectable style={styles.code}>
			{children}
		</Text>
	);
}

export function EmptyState({
	children,
	title,
	systemImage = 'tray',
}: PropsWithChildren<{
	title?: string;
	systemImage?: DevToolsSystemImage;
}>) {
	return (
		<View style={styles.empty}>
			<View style={styles.emptyIcon}>
				<SystemIcon
					systemName={systemImage}
					size={24}
					color={colors.secondaryLabel}
				/>
			</View>
			{title ? <Text style={styles.emptyTitle}>{title}</Text> : null}
			<Text style={styles.emptyText}>{children}</Text>
		</View>
	);
}

export const panelStyles = StyleSheet.create({
	sectionLabel: {
		color: colors.secondaryLabel,
		fontSize: 12,
		fontWeight: '600',
		letterSpacing: 0.5,
		marginBottom: 2,
		marginLeft: 16,
		textTransform: 'uppercase',
	},
	valueRow: {
		alignItems: 'flex-start',
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
		gap: 6,
		paddingHorizontal: 16,
		paddingVertical: 12,
	},
	valueKey: {
		color: colors.label,
		fontSize: 15,
		fontWeight: '600',
	},
	valueText: {
		color: colors.secondaryLabel,
		fontFamily: 'Menlo',
		fontSize: 12,
		lineHeight: 18,
	},
});

const styles = StyleSheet.create({
	screen: {
		backgroundColor: colors.background,
		flex: 1,
	},
	header: {
		alignItems: 'center',
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		minHeight: 84,
		paddingBottom: 12,
		paddingHorizontal: 12,
		paddingTop: 20,
	},
	backButton: {
		alignItems: 'center',
		borderRadius: 18,
		height: 36,
		justifyContent: 'center',
		width: 36,
	},
	headerCopy: {
		flex: 1,
		paddingHorizontal: 6,
	},
	title: {
		color: colors.label,
		fontSize: 20,
		fontWeight: '700',
		letterSpacing: -0.4,
	},
	subtitle: {
		color: colors.secondaryLabel,
		fontSize: 12,
		marginTop: 1,
	},
	headerAccessory: {
		alignItems: 'flex-end',
		minWidth: 36,
	},
	content: {
		gap: 10,
		paddingBottom: 48,
		paddingHorizontal: 14,
		paddingTop: 14,
	},
	listHeader: {
		gap: 8,
		marginBottom: 8,
	},
	listSeparator: {
		height: 8,
	},
	card: {
		backgroundColor: colors.card,
		borderRadius: 14,
		overflow: 'hidden',
	},
	cardButton: {
		alignItems: 'center',
		flexDirection: 'row',
		minHeight: 62,
		paddingHorizontal: 14,
		paddingVertical: 11,
	},
	cardCopy: {
		flex: 1,
		gap: 3,
	},
	cardTitle: {
		color: colors.label,
		fontSize: 15,
		fontWeight: '600',
	},
	cardSubtitle: {
		color: colors.secondaryLabel,
		fontSize: 12,
		lineHeight: 16,
	},
	details: {
		borderTopColor: colors.separator,
		borderTopWidth: StyleSheet.hairlineWidth,
		padding: 14,
	},
	code: {
		backgroundColor: colors.background,
		borderColor: colors.separator,
		borderRadius: 10,
		borderWidth: StyleSheet.hairlineWidth,
		color: colors.label,
		fontFamily: 'Menlo',
		fontSize: 11,
		lineHeight: 17,
		overflow: 'hidden',
		padding: 10,
	},
	metricStrip: {
		backgroundColor: colors.card,
		borderRadius: 14,
		flexDirection: 'row',
		overflow: 'hidden',
	},
	metric: {
		alignItems: 'center',
		flex: 1,
		justifyContent: 'center',
		minHeight: 58,
		paddingHorizontal: 4,
		paddingVertical: 9,
	},
	metricDivider: {
		borderLeftColor: colors.separator,
		borderLeftWidth: StyleSheet.hairlineWidth,
	},
	metricValue: {
		fontSize: 18,
		fontVariant: ['tabular-nums'],
		fontWeight: '700',
		letterSpacing: -0.3,
	},
	metricLabel: {
		color: colors.secondaryLabel,
		fontSize: 10,
		marginTop: 2,
	},
	signalCard: {
		alignItems: 'flex-start',
		backgroundColor: colors.card,
		borderRadius: 16,
		flexDirection: 'row',
		gap: 12,
		padding: 15,
	},
	signalIcon: {
		alignItems: 'center',
		backgroundColor: colors.background,
		borderRadius: 12,
		height: 44,
		justifyContent: 'center',
		width: 44,
	},
	signalCopy: {
		flex: 1,
		gap: 3,
	},
	signalEyebrow: {
		fontSize: 11,
		fontWeight: '700',
		letterSpacing: 0.6,
		textTransform: 'uppercase',
	},
	signalTitle: {
		color: colors.label,
		fontSize: 18,
		fontWeight: '700',
		letterSpacing: -0.35,
	},
	signalDescription: {
		color: colors.secondaryLabel,
		fontSize: 12,
		lineHeight: 17,
	},
	statusBadge: {
		alignItems: 'center',
		borderRadius: 10,
		borderWidth: 1,
		justifyContent: 'center',
		marginRight: 10,
		minHeight: 22,
		minWidth: 42,
		paddingHorizontal: 7,
	},
	statusBadgeText: {
		fontSize: 10,
		fontVariant: ['tabular-nums'],
		fontWeight: '700',
	},
	empty: {
		alignItems: 'center',
		paddingHorizontal: 32,
		paddingVertical: 48,
	},
	emptyIcon: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderRadius: 22,
		height: 44,
		justifyContent: 'center',
		marginBottom: 10,
		width: 44,
	},
	emptyTitle: {
		color: colors.label,
		fontSize: 16,
		fontWeight: '600',
		marginBottom: 3,
	},
	emptyText: {
		color: colors.secondaryLabel,
		fontSize: 15,
		lineHeight: 21,
		textAlign: 'center',
	},
});
