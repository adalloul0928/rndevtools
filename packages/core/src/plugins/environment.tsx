import { Share, StyleSheet, Text, View } from 'react-native';
import { PanelButton, PanelToolbar } from '../components/panel-controls';
import {
	colors,
	DisclosureCard,
	PanelScaffold,
	panelStyles,
} from '../components/panel-ui';
import { serializeValue } from '../core/serialize';
import type { DevToolsPanelPlugin, DevToolsSystemImage } from '../types';

export type EnvironmentValueType =
	| 'string'
	| 'number'
	| 'boolean'
	| 'object'
	| 'array';

export type EnvironmentValueRule = {
	key: string;
	section?: string;
	description?: string;
	required?: boolean;
	expectedType?: EnvironmentValueType;
	expectedValue?: unknown;
};

export type EnvironmentValidationStatus =
	| 'valid'
	| 'missing'
	| 'typeMismatch'
	| 'valueMismatch';

export type EnvironmentValidationResult = EnvironmentValueRule & {
	status: EnvironmentValidationStatus;
	actualValue?: unknown;
	actualType?: string;
};

export type EnvironmentSection = {
	title: string;
	values: Readonly<Record<string, unknown>>;
};

export type EnvironmentPluginOptions = {
	values?: Readonly<Record<string, unknown>>;
	sections?: ReadonlyArray<EnvironmentSection>;
	rules?: readonly EnvironmentValueRule[];
	title?: string;
	id?: string;
	description?: string;
	section?: string;
	systemImage?: DevToolsSystemImage;
};

function valueType(value: unknown): string {
	if (Array.isArray(value)) return 'array';
	if (value === null) return 'null';
	return typeof value;
}

function isMissing(value: unknown): boolean {
	return value === undefined || value === null || value === '';
}

function environmentValuesEqual(
	left: unknown,
	right: unknown,
	seen = new WeakMap<object, WeakSet<object>>(),
): boolean {
	if (Object.is(left, right)) return true;
	if (
		!left ||
		!right ||
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		Array.isArray(left) !== Array.isArray(right)
	) {
		return false;
	}
	const matched = seen.get(left);
	if (matched?.has(right)) return true;
	if (matched) matched.add(right);
	else seen.set(left, new WeakSet([right]));

	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((value, index) =>
				environmentValuesEqual(value, right[index], seen),
			)
		);
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	const leftKeys = Object.keys(leftRecord);
	const rightKeys = Object.keys(rightRecord);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) =>
				Object.hasOwn(rightRecord, key) &&
				environmentValuesEqual(leftRecord[key], rightRecord[key], seen),
		)
	);
}

export function validateEnvironmentValues(
	sections: readonly EnvironmentSection[],
	rules: readonly EnvironmentValueRule[],
): readonly EnvironmentValidationResult[] {
	return rules.map((rule) => {
		const candidates = rule.section
			? sections.filter((section) => section.title === rule.section)
			: sections;
		const section = candidates.find((entry) =>
			Object.hasOwn(entry.values, rule.key),
		);
		const actualValue = section?.values[rule.key];
		const actualType = valueType(actualValue);
		if (isMissing(actualValue)) {
			return {
				...rule,
				actualValue,
				actualType,
				status: rule.required === false ? 'valid' : 'missing',
			};
		}
		if (rule.expectedType && actualType !== rule.expectedType) {
			return {
				...rule,
				actualValue,
				actualType,
				status: 'typeMismatch',
			};
		}
		if (
			Object.hasOwn(rule, 'expectedValue') &&
			!environmentValuesEqual(actualValue, rule.expectedValue)
		) {
			return {
				...rule,
				actualValue,
				actualType,
				status: 'valueMismatch',
			};
		}
		return { ...rule, actualValue, actualType, status: 'valid' };
	});
}

function validationLabel(result: EnvironmentValidationResult): string {
	if (result.status === 'valid') return 'Valid';
	if (result.status === 'missing') return 'Missing';
	if (result.status === 'typeMismatch') {
		return `Expected ${result.expectedType}, found ${result.actualType}`;
	}
	return `Expected ${serializeValue(result.expectedValue, 256).text}`;
}

export function createEnvironmentPlugin({
	values = {},
	sections,
	rules = [],
	title = 'Environment',
	id = 'environment',
	description = 'Declared build and runtime values',
	section,
	systemImage = 'gearshape.2.fill',
}: EnvironmentPluginOptions): DevToolsPanelPlugin {
	const declaredSections =
		sections && sections.length > 0
			? sections
			: [{ title: 'Application manifest', values }];
	const sectionTitles = new Set<string>();
	for (const declaredSection of declaredSections) {
		if (!declaredSection.title.trim()) {
			throw new Error('Environment section titles cannot be empty.');
		}
		if (sectionTitles.has(declaredSection.title)) {
			throw new Error(
				`Duplicate environment section title: ${declaredSection.title}`,
			);
		}
		sectionTitles.add(declaredSection.title);
	}

	function EnvironmentPanel({ onBack }: { onBack: () => void }) {
		const entryCount = declaredSections.reduce(
			(sum, section) => sum + Object.keys(section.values).length,
			0,
		);
		const validationResults = validateEnvironmentValues(
			declaredSections,
			rules,
		);
		const validCount = validationResults.filter(
			(result) => result.status === 'valid',
		).length;
		const missingCount = validationResults.filter(
			(result) => result.status === 'missing',
		).length;
		const issueCount = validationResults.length - validCount - missingCount;
		const health = validationResults.length
			? Math.round((validCount / validationResults.length) * 100)
			: 100;
		const exportValue = Object.fromEntries(
			declaredSections.map((section) => [section.title, section.values]),
		);

		return (
			<PanelScaffold
				onBack={onBack}
				title={title}
				subtitle={`${entryCount} declared values`}
			>
				<PanelToolbar>
					<PanelButton
						label="Share manifest"
						onPress={() => {
							void Share.share({
								message: serializeValue(exportValue, 512 * 1024).text,
								title,
							}).catch(() => undefined);
						}}
					/>
				</PanelToolbar>
				{validationResults.length ? (
					<View style={styles.validationSection}>
						<Text style={panelStyles.sectionLabel}>Configuration health</Text>
						<View style={styles.healthCard}>
							<View style={styles.healthCopy}>
								<Text style={styles.healthTitle}>Environment checks</Text>
								<Text style={styles.healthSubtitle}>
									{validCount} of {validationResults.length} checks pass
								</Text>
							</View>
							<Text
								style={[
									styles.healthValue,
									{ color: health === 100 ? colors.green : colors.orange },
								]}
							>
								{health}%
							</Text>
						</View>
						<View style={styles.metrics}>
							<View style={styles.metric}>
								<Text style={styles.metricValue}>{validCount}</Text>
								<Text style={styles.metricLabel}>Valid</Text>
							</View>
							<View style={styles.metric}>
								<Text style={[styles.metricValue, { color: colors.red }]}>
									{missingCount}
								</Text>
								<Text style={styles.metricLabel}>Missing</Text>
							</View>
							<View style={styles.metric}>
								<Text style={[styles.metricValue, { color: colors.orange }]}>
									{issueCount}
								</Text>
								<Text style={styles.metricLabel}>Issues</Text>
							</View>
						</View>
						{validationResults.map((result) => (
							<DisclosureCard
								key={`${result.section ?? '*'}:${result.key}`}
								title={result.key}
								subtitle={validationLabel(result)}
								leading={
									<View
										style={[
											styles.statusDot,
											{
												backgroundColor:
													result.status === 'valid'
														? colors.green
														: result.status === 'missing'
															? colors.red
															: colors.orange,
											},
										]}
									/>
								}
							>
								{result.description ? (
									<Text style={styles.validationDescription}>
										{result.description}
									</Text>
								) : null}
								<Text selectable style={panelStyles.valueText}>
									Actual: {serializeValue(result.actualValue, 16 * 1024).text}
								</Text>
							</DisclosureCard>
						))}
					</View>
				) : null}
				{declaredSections.map((section) => {
					const entries = Object.entries(section.values).sort(
						([left], [right]) => left.localeCompare(right),
					);
					return (
						<View key={section.title} style={styles.section}>
							<Text style={panelStyles.sectionLabel}>{section.title}</Text>
							<View style={styles.group}>
								{entries.map(([key, value]) => (
									<View key={key} style={panelStyles.valueRow}>
										<Text style={panelStyles.valueKey}>{key}</Text>
										<Text selectable style={panelStyles.valueText}>
											{serializeValue(value, 16 * 1024).text}
										</Text>
									</View>
								))}
							</View>
						</View>
					);
				})}
			</PanelScaffold>
		);
	}

	return {
		id,
		title,
		description,
		systemImage,
		section,
		Panel: EnvironmentPanel,
	};
}

const styles = StyleSheet.create({
	validationSection: { gap: 8 },
	healthCard: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderRadius: 16,
		flexDirection: 'row',
		padding: 16,
	},
	healthCopy: { flex: 1, gap: 3 },
	healthTitle: { color: colors.label, fontSize: 16, fontWeight: '700' },
	healthSubtitle: { color: colors.secondaryLabel, fontSize: 12 },
	healthValue: { fontSize: 24, fontWeight: '700', letterSpacing: -0.7 },
	metrics: { flexDirection: 'row', gap: 8 },
	metric: {
		alignItems: 'center',
		backgroundColor: colors.card,
		borderRadius: 14,
		flex: 1,
		paddingVertical: 12,
	},
	metricValue: { color: colors.green, fontSize: 20, fontWeight: '700' },
	metricLabel: { color: colors.secondaryLabel, fontSize: 11, marginTop: 2 },
	statusDot: { borderRadius: 5, height: 10, marginRight: 12, width: 10 },
	validationDescription: {
		color: colors.secondaryLabel,
		fontSize: 13,
		lineHeight: 18,
		marginBottom: 8,
	},
	section: { gap: 4 },
	group: {
		backgroundColor: colors.card,
		borderRadius: 16,
		overflow: 'hidden',
	},
});
