import {
	createContext,
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
import { FlatList, RectButton, ScrollView } from 'react-native-gesture-handler';
import type {
	DevToolsPanelProps,
	DevToolsPresentationMode,
	DevToolsSystemImage,
} from '../types';
import { SystemIcon } from './system-icon';

export const colors = {
	background: PlatformColor('systemGroupedBackgroundColor'),
	card: PlatformColor('secondarySystemGroupedBackgroundColor'),
	label: PlatformColor('labelColor'),
	secondaryLabel: PlatformColor('secondaryLabelColor'),
	separator: PlatformColor('separatorColor'),
	fill: PlatformColor('tertiarySystemFillColor'),
	groupedFill: PlatformColor('tertiarySystemGroupedBackgroundColor'),
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

const PanelPresentationContext = createContext<{
	mode: DevToolsPresentationMode;
	safeAreaTop: number;
}>({ mode: 'sheet', safeAreaTop: 0 });

export function PanelPresentationProvider({
	children,
	mode,
	safeAreaTop = 0,
}: PropsWithChildren<{
	mode: DevToolsPresentationMode;
	safeAreaTop?: number;
}>) {
	return (
		<PanelPresentationContext.Provider value={{ mode, safeAreaTop }}>
			{children}
		</PanelPresentationContext.Provider>
	);
}

export function PanelScaffold({
	title,
	subtitle,
	onBack,
	rightAccessory,
	children,
	scrollable = true,
}: PanelScaffoldProps) {
	return (
		<View style={styles.screen}>
			<View
				accessibilityLabel={[title, subtitle].filter(Boolean).join(', ')}
				style={styles.header}
			>
				<RectButton
					onPress={onBack}
					accessibilityLabel="All tools"
					accessibilityRole="button"
					style={styles.backButton}
				>
					<SystemIcon
						color={colors.label}
						systemName="chevron.left"
						size={17}
					/>
				</RectButton>
				<View style={styles.headerCopy}>
					<Text numberOfLines={1} style={styles.title}>
						{title}
					</Text>
				</View>
				<View style={styles.headerAccessory}>{rightAccessory}</View>
			</View>
			{scrollable ? (
				<ScrollView
					contentContainerStyle={styles.content}
					showsVerticalScrollIndicator={false}
				>
					{children}
				</ScrollView>
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
		<View
			accessibilityLabel={[eyebrow, title, description].join(', ')}
			style={styles.signalCard}
		>
			<SystemIcon systemName={systemImage} size={15} color={accent} />
			<Text numberOfLines={1} style={styles.signalTitle}>
				{title}
			</Text>
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
					size={12}
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
		fontSize: 13,
		fontWeight: '600',
		marginBottom: 1,
		marginLeft: 4,
		marginTop: 4,
	},
	valueRow: {
		alignItems: 'flex-start',
		gap: 6,
		paddingHorizontal: 14,
		paddingVertical: 10,
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
		backgroundColor: colors.card,
		borderBottomColor: colors.separator,
		borderBottomWidth: StyleSheet.hairlineWidth,
		flexDirection: 'row',
		height: 52,
		paddingHorizontal: 4,
	},
	backButton: {
		alignItems: 'center',
		backgroundColor: colors.fill,
		borderColor: colors.separator,
		borderRadius: 22,
		borderWidth: StyleSheet.hairlineWidth,
		height: 44,
		justifyContent: 'center',
		width: 44,
	},
	headerCopy: {
		alignItems: 'center',
		flex: 1,
		justifyContent: 'center',
		paddingHorizontal: 4,
	},
	title: {
		color: colors.label,
		fontSize: 17,
		fontWeight: '600',
		letterSpacing: -0.2,
		textAlign: 'center',
	},
	headerAccessory: {
		alignItems: 'flex-end',
		minWidth: 44,
	},
	content: {
		gap: 14,
		paddingBottom: 28,
		paddingHorizontal: 16,
		paddingTop: 18,
	},
	listHeader: {
		gap: 7,
		marginBottom: 7,
	},
	listSeparator: {
		height: 7,
	},
	card: {
		backgroundColor: colors.card,
		borderRadius: 16,
		overflow: 'hidden',
	},
	cardButton: {
		alignItems: 'center',
		flexDirection: 'row',
		minHeight: 56,
		paddingHorizontal: 13,
		paddingVertical: 9,
	},
	cardCopy: {
		flex: 1,
		gap: 3,
	},
	cardTitle: {
		color: colors.label,
		fontSize: 16,
		fontWeight: '500',
	},
	cardSubtitle: {
		color: colors.secondaryLabel,
		fontSize: 12,
		lineHeight: 16,
	},
	details: {
		borderTopColor: colors.separator,
		borderTopWidth: StyleSheet.hairlineWidth,
		padding: 12,
	},
	code: {
		backgroundColor: colors.background,
		borderColor: colors.separator,
		borderRadius: 8,
		borderWidth: StyleSheet.hairlineWidth,
		color: colors.label,
		fontFamily: 'Menlo',
		fontSize: 11,
		lineHeight: 17,
		overflow: 'hidden',
		padding: 9,
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
		minHeight: 42,
		paddingHorizontal: 4,
		paddingVertical: 5,
	},
	metricDivider: {
		borderLeftColor: colors.separator,
		borderLeftWidth: StyleSheet.hairlineWidth,
	},
	metricValue: {
		fontSize: 15,
		fontVariant: ['tabular-nums'],
		fontWeight: '700',
		letterSpacing: -0.3,
	},
	metricLabel: {
		color: colors.secondaryLabel,
		fontSize: 9,
		marginTop: 1,
	},
	signalCard: {
		alignItems: 'center',
		flexDirection: 'row',
		gap: 7,
		minHeight: 28,
		paddingHorizontal: 4,
	},
	signalTitle: {
		color: colors.label,
		flex: 1,
		fontSize: 13,
		fontWeight: '500',
	},
	statusBadge: {
		alignItems: 'center',
		borderRadius: 8,
		borderWidth: 1,
		justifyContent: 'center',
		marginRight: 10,
		minHeight: 20,
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
		paddingVertical: 38,
	},
	emptyIcon: {
		alignItems: 'center',
		height: 32,
		justifyContent: 'center',
		marginBottom: 8,
		width: 32,
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
