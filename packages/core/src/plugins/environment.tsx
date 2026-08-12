import { Share, StyleSheet, Text, View } from 'react-native';
import { PanelButton, PanelToolbar } from '../components/panel-controls';
import {
	CodeBlock,
	colors,
	DisclosureCard,
	PanelMetricStrip,
	PanelScaffold,
	PanelSignalCard,
	PanelStatusBadge,
	panelStyles,
} from '../components/panel-ui';
import { serializeValue } from '../core/serialize';
import type { DevToolsPanelPlugin, DevToolsSystemImage } from '../types';

export function formatEnvironmentValue(value: unknown): string {
	if (value === undefined || value === null || value === '') return 'Not set';
	if (typeof value === 'string') return value;
	if (typeof value === 'boolean' || typeof value === 'number') {
		return String(value);
	}
	return serializeValue(value, 16 * 1024).text;
}

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

function formatEnvironmentKey(key: string): string {
	return key
		.replace(/^EXPO_PUBLIC_/, '')
		.split(/[_\-.]+/)
		.filter(Boolean)
		.map((part) => `${part.charAt(0)}${part.slice(1).toLowerCase()}`)
		.join(' ');
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
				<PanelSignalCard
					description={
						validationResults.length
							? `${validCount} of ${validationResults.length} declared checks pass.`
							: `${entryCount} values were deliberately provided by the app.`
					}
					eyebrow="Configuration signal"
					systemImage={
						missingCount + issueCount > 0
							? 'exclamationmark.triangle.fill'
							: 'checkmark.circle.fill'
					}
					title={
						missingCount + issueCount > 0
							? `${missingCount + issueCount} configuration issue${missingCount + issueCount === 1 ? '' : 's'}`
							: 'Configuration looks healthy'
					}
					tone={missingCount + issueCount > 0 ? 'warning' : 'success'}
				/>
				{validationResults.length ? (
					<View style={styles.validationSection}>
						<Text style={panelStyles.sectionLabel}>Configuration checks</Text>
						<PanelMetricStrip
							metrics={[
								{ label: 'Health', value: `${health}%` },
								{ label: 'Valid', value: validCount, tone: colors.green },
								{ label: 'Missing', value: missingCount, tone: colors.red },
								{ label: 'Issues', value: issueCount, tone: colors.orange },
							]}
						/>
						{validationResults.map((result) => (
							<DisclosureCard
								key={`${result.section ?? '*'}:${result.key}`}
								title={formatEnvironmentKey(result.key)}
								subtitle={`${validationLabel(result)} · ${result.key}`}
								leading={
									<PanelStatusBadge
										label={result.status === 'valid' ? 'PASS' : 'ISSUE'}
										tone={result.status === 'valid' ? 'success' : 'warning'}
									/>
								}
							>
								{result.description ? (
									<Text style={styles.validationDescription}>
										{result.description}
									</Text>
								) : null}
								<View style={styles.actualValue}>
									<Text style={styles.actualLabel}>Actual value</Text>
									<CodeBlock>
										{formatEnvironmentValue(result.actualValue)}
									</CodeBlock>
								</View>
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
										<Text style={panelStyles.valueKey}>
											{formatEnvironmentKey(key)}
										</Text>
										<Text selectable style={styles.rawKey}>
											{key}
										</Text>
										<Text selectable style={panelStyles.valueText}>
											{formatEnvironmentValue(value)}
										</Text>
									</View>
								))}
							</View>
						</View>
					);
				})}
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
	rawKey: {
		color: colors.secondaryLabel,
		fontFamily: 'Menlo',
		fontSize: 10,
	},
	validationDescription: {
		color: colors.secondaryLabel,
		fontSize: 13,
		lineHeight: 18,
		marginBottom: 8,
	},
	actualValue: { gap: 7 },
	actualLabel: {
		color: colors.secondaryLabel,
		fontSize: 12,
		fontWeight: '600',
	},
	section: { gap: 4 },
	group: {
		backgroundColor: colors.card,
		borderColor: colors.separator,
		borderRadius: 12,
		borderWidth: StyleSheet.hairlineWidth,
		overflow: 'hidden',
	},
});
