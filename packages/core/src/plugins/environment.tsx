import {
	Button,
	DisclosureGroup,
	Host,
	Label,
	LabeledContent,
	List,
	Section,
	Text as UIText,
} from '@expo/ui/swift-ui';
import { listStyle } from '@expo/ui/swift-ui/modifiers';
import { Platform, PlatformColor, Share } from 'react-native';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
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
	tint?: string;
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

/**
 * Collapsed-row summary. Deliberately short: a serialized expected value would
 * be truncated to nothing useful in a disclosure label, so both values are
 * rendered as rows inside the expansion instead.
 */
export function validationLabel(result: EnvironmentValidationResult): string {
	if (result.status === 'valid') return 'Valid';
	if (result.status === 'missing') return 'Missing';
	if (result.status === 'typeMismatch') {
		return `Expected ${result.expectedType}, found ${result.actualType}`;
	}
	return 'Unexpected value';
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
	tint = '#34C759',
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
		const validationResults = validateEnvironmentValues(
			declaredSections,
			rules,
		);
		const failing = validationResults.filter(
			(result) => result.status !== 'valid',
		);
		const exportValue = Object.fromEntries(
			declaredSections.map((declared) => [declared.title, declared.values]),
		);
		const shareManifest = () => {
			void Share.share({
				message: serializeValue(exportValue, 512 * 1024).text,
				title,
			}).catch(() => undefined);
		};

		return (
			<PanelShell
				onBack={onBack}
				title={title}
				trailing={
					<NavIconButton
						accessibilityLabel="Share manifest"
						onPress={shareManifest}
						systemImage="square.and.arrow.up"
						testID="devtools-environment-share"
					/>
				}
			>
				{Platform.OS === 'ios' ? (
					<Host style={{ flex: 1 }}>
						<List modifiers={[listStyle('insetGrouped')]}>
							{validationResults.length > 0 ? (
								<Section>
									<Label
										color={
											failing.length > 0
												? PlatformColor('systemOrangeColor')
												: PlatformColor('systemGreenColor')
										}
										systemImage={
											failing.length > 0
												? 'exclamationmark.triangle.fill'
												: 'checkmark.circle.fill'
										}
										title={
											failing.length > 0
												? `${failing.length} of ${validationResults.length} checks failing`
												: `${validationResults.length} of ${validationResults.length} checks passing`
										}
									/>
									{failing.map((result) => (
										<DisclosureGroup
											key={`${result.section ?? '*'}:${result.key}`}
											label={`${formatEnvironmentKey(result.key)} — ${validationLabel(result)}`}
										>
											{result.description ? (
												<UIText>{result.description}</UIText>
											) : null}
											{Object.hasOwn(result, 'expectedValue') ? (
												<LabeledContent label="Expected">
													<UIText>
														{formatEnvironmentValue(result.expectedValue)}
													</UIText>
												</LabeledContent>
											) : null}
											<LabeledContent label="Actual">
												<UIText>
													{formatEnvironmentValue(result.actualValue)}
												</UIText>
											</LabeledContent>
										</DisclosureGroup>
									))}
								</Section>
							) : null}
							{declaredSections.map((declared) => {
								const entries = Object.entries(declared.values).sort(
									([left], [right]) => left.localeCompare(right),
								);
								return (
									<Section key={declared.title} title={declared.title}>
										{entries.map(([key, value]) => (
											<LabeledContent
												key={key}
												label={formatEnvironmentKey(key)}
											>
												<UIText>{formatEnvironmentValue(value)}</UIText>
											</LabeledContent>
										))}
									</Section>
								);
							})}
							<Section footer={<UIText>Fixed at build time.</UIText>}>
								<Button label="Share manifest…" onPress={shareManifest} />
							</Section>
						</List>
					</Host>
				) : null}
			</PanelShell>
		);
	}

	return {
		id,
		title,
		description,
		systemImage,
		tint,
		section,
		Panel: EnvironmentPanel,
	};
}
