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
import { Platform, PlatformColor } from 'react-native';
import {
	AndroidPanelRow,
	AndroidPanelScroll,
	AndroidPanelSection,
} from '../components/android-panel-ui';
import { NavIconButton } from '../components/nav-controls';
import { PanelShell } from '../components/panel-shell';
import {
	isSensitiveDiagnosticKey,
	sanitizeDiagnosticValue,
} from '../core/redact';
import { serializeValue, truncateText } from '../core/serialize';
import { shareDiagnosticContent } from '../core/share';
import type { DevToolsPanelPlugin, DevToolsSystemImage } from '../types';

const MAX_ENVIRONMENT_RENDERED_VALUE_BYTES = 16 * 1024;
const MAX_ENVIRONMENT_TEXT_LENGTH = 4 * 1024;

export function formatEnvironmentValue(value: unknown): string {
	if (value === undefined || value === null || value === '') return 'Not set';
	const sanitized = sanitizeDiagnosticValue(value);
	if (typeof sanitized === 'string') {
		return truncateText(sanitized, MAX_ENVIRONMENT_RENDERED_VALUE_BYTES).text;
	}
	if (typeof value === 'boolean' || typeof value === 'number') {
		return String(value);
	}
	return serializeValue(sanitized, MAX_ENVIRONMENT_RENDERED_VALUE_BYTES).text;
}

function formatEnvironmentEntry(key: string, value: unknown): string {
	return isSensitiveDiagnosticKey(key)
		? '[REDACTED]'
		: formatEnvironmentValue(value);
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

const MAX_ENVIRONMENT_ENTRIES_PER_SECTION = 5_000;
const MAX_ENVIRONMENT_COMPARISON_DEPTH = 32;
const MAX_ENVIRONMENT_COMPARISON_ENTRIES = 10_000;

function valueType(value: unknown): string {
	if (Array.isArray(value)) return 'array';
	if (value === null) return 'null';
	return typeof value;
}

function isMissing(value: unknown): boolean {
	return value === undefined || value === null || value === '';
}

function environmentSectionEntries(
	section: EnvironmentSection,
	rejectOverflow = false,
): readonly (readonly [string, unknown])[] {
	let descriptors: Record<string, PropertyDescriptor>;
	try {
		descriptors = Object.getOwnPropertyDescriptors(section.values);
	} catch {
		return [];
	}
	const entries = Object.entries(descriptors).filter(
		([, descriptor]) => descriptor.enumerable,
	);
	if (entries.length > MAX_ENVIRONMENT_ENTRIES_PER_SECTION) {
		if (rejectOverflow) {
			throw new Error(
				`Environment sections support at most ${MAX_ENVIRONMENT_ENTRIES_PER_SECTION} values.`,
			);
		}
		entries.length = MAX_ENVIRONMENT_ENTRIES_PER_SECTION;
	}
	return entries.map(
		([key, descriptor]) =>
			[
				key,
				'value' in descriptor ? descriptor.value : '[Accessor omitted]',
			] as const,
	);
}

type EnvironmentComparisonState = {
	remaining: number;
	seen: WeakMap<object, WeakSet<object>>;
};

function environmentValuesEqual(
	left: unknown,
	right: unknown,
	state: EnvironmentComparisonState = {
		remaining: MAX_ENVIRONMENT_COMPARISON_ENTRIES,
		seen: new WeakMap<object, WeakSet<object>>(),
	},
	depth = 0,
): boolean {
	if (Object.is(left, right)) return true;
	if (depth >= MAX_ENVIRONMENT_COMPARISON_DEPTH || state.remaining <= 0) {
		return false;
	}
	state.remaining -= 1;
	if (
		!left ||
		!right ||
		typeof left !== 'object' ||
		typeof right !== 'object' ||
		Array.isArray(left) !== Array.isArray(right)
	) {
		return false;
	}
	try {
		if (left instanceof Date || right instanceof Date) {
			return (
				left instanceof Date &&
				right instanceof Date &&
				Date.prototype.getTime.call(left) === Date.prototype.getTime.call(right)
			);
		}
		if (!Array.isArray(left)) {
			const leftPrototype = Object.getPrototypeOf(left);
			const rightPrototype = Object.getPrototypeOf(right);
			const leftIsPlain =
				leftPrototype === Object.prototype || leftPrototype === null;
			const rightIsPlain =
				rightPrototype === Object.prototype || rightPrototype === null;
			if (!leftIsPlain || !rightIsPlain) return false;
		}
	} catch {
		return false;
	}
	const matched = state.seen.get(left);
	if (matched?.has(right)) return true;
	if (matched) matched.add(right);
	else state.seen.set(left, new WeakSet([right]));

	let leftDescriptors: Record<string, PropertyDescriptor>;
	let rightDescriptors: Record<string, PropertyDescriptor>;
	try {
		leftDescriptors = Object.getOwnPropertyDescriptors(left);
		rightDescriptors = Object.getOwnPropertyDescriptors(right);
	} catch {
		return false;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		const leftLength = leftDescriptors.length;
		const rightLength = rightDescriptors.length;
		if (
			!leftLength ||
			!rightLength ||
			!('value' in leftLength) ||
			!('value' in rightLength) ||
			leftLength.value !== rightLength.value ||
			typeof leftLength.value !== 'number' ||
			leftLength.value > MAX_ENVIRONMENT_COMPARISON_ENTRIES
		) {
			return false;
		}
		for (let index = 0; index < leftLength.value; index += 1) {
			const leftDescriptor = leftDescriptors[String(index)];
			const rightDescriptor = rightDescriptors[String(index)];
			if (
				!leftDescriptor ||
				!rightDescriptor ||
				!('value' in leftDescriptor) ||
				!('value' in rightDescriptor) ||
				!environmentValuesEqual(
					leftDescriptor.value,
					rightDescriptor.value,
					state,
					depth + 1,
				)
			) {
				return false;
			}
		}
		return true;
	}
	const leftKeys = Object.entries(leftDescriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.map(([key]) => key);
	const rightKeys = Object.entries(rightDescriptors)
		.filter(([, descriptor]) => descriptor.enumerable)
		.map(([key]) => key);
	if (
		leftKeys.length > MAX_ENVIRONMENT_COMPARISON_ENTRIES ||
		rightKeys.length > MAX_ENVIRONMENT_COMPARISON_ENTRIES
	) {
		return false;
	}
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key) => {
			const leftDescriptor = leftDescriptors[key];
			const rightDescriptor = rightDescriptors[key];
			return (
				leftDescriptor !== undefined &&
				rightDescriptor !== undefined &&
				'value' in leftDescriptor &&
				'value' in rightDescriptor &&
				environmentValuesEqual(
					leftDescriptor.value,
					rightDescriptor.value,
					state,
					depth + 1,
				)
			);
		})
	);
}

const environmentValueTypes = new Set<EnvironmentValueType>([
	'string',
	'number',
	'boolean',
	'object',
	'array',
]);

function assertEnvironmentRules(
	sections: readonly EnvironmentSection[],
	rules: readonly EnvironmentValueRule[],
): void {
	const sectionTitles = new Set(sections.map((entry) => entry.title));
	const signatures = new Set<string>();
	const scopesByKey = new Map<string, Set<string>>();
	for (const rule of rules) {
		if (
			!rule ||
			typeof rule !== 'object' ||
			typeof rule.key !== 'string' ||
			!rule.key.trim() ||
			rule.key.length > 4 * 1024
		) {
			throw new Error('Environment rule keys must be 1–4096 characters.');
		}
		if (
			rule.description !== undefined &&
			(typeof rule.description !== 'string' ||
				rule.description.length > MAX_ENVIRONMENT_TEXT_LENGTH)
		) {
			throw new Error(
				'Environment rule descriptions cannot exceed 4096 characters.',
			);
		}
		if (rule.section && !sectionTitles.has(rule.section)) {
			throw new Error(`Unknown environment rule section: ${rule.section}`);
		}
		if (
			rule.expectedType !== undefined &&
			!environmentValueTypes.has(rule.expectedType)
		) {
			throw new Error(
				`Invalid expected type for environment rule ${rule.key}.`,
			);
		}
		const signature = `${rule.section ?? '*'}\u0000${rule.key}`;
		if (signatures.has(signature)) {
			throw new Error(
				`Duplicate environment rule: ${rule.section ?? '*'}:${rule.key}`,
			);
		}
		signatures.add(signature);
		const scope = rule.section ?? '*';
		const existingScopes = scopesByKey.get(rule.key) ?? new Set<string>();
		if (existingScopes.size > 0 && (scope === '*' || existingScopes.has('*'))) {
			throw new Error(
				`Overlapping environment rules require explicit, non-global sections: ${rule.key}`,
			);
		}
		existingScopes.add(scope);
		scopesByKey.set(rule.key, existingScopes);
		if (!rule.section) {
			const matchingSectionCount = sections.filter((entry) =>
				environmentSectionEntries(entry).some(([key]) => key === rule.key),
			).length;
			if (matchingSectionCount > 1) {
				throw new Error(
					`Environment rule ${rule.key} is ambiguous; specify its section.`,
				);
			}
		}
	}
}

export function validateEnvironmentValues(
	sections: readonly EnvironmentSection[],
	rules: readonly EnvironmentValueRule[],
): readonly EnvironmentValidationResult[] {
	return rules.map((rule) => {
		const candidates = rule.section
			? sections.filter((section) => section.title === rule.section)
			: sections;
		const sectionEntry = candidates
			.flatMap((entry) =>
				environmentSectionEntries(entry).map(([key, value]) => ({
					key,
					value,
				})),
			)
			.find((entry) => entry.key === rule.key);
		const actualValue = sectionEntry?.value;
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
function validationLabel(result: EnvironmentValidationResult): string {
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
	if (!Array.isArray(declaredSections) || declaredSections.length > 50) {
		throw new Error('Environment diagnostics support at most 50 sections.');
	}
	if (!Array.isArray(rules) || rules.length > 500) {
		throw new Error('Environment diagnostics support at most 500 rules.');
	}
	const sectionTitles = new Set<string>();
	for (const declaredSection of declaredSections) {
		if (
			!declaredSection ||
			typeof declaredSection !== 'object' ||
			typeof declaredSection.title !== 'string' ||
			!declaredSection.title.trim() ||
			declaredSection.title.length > 4 * 1024
		) {
			throw new Error('Environment section titles must be 1–4096 characters.');
		}
		if (
			!declaredSection.values ||
			typeof declaredSection.values !== 'object' ||
			Array.isArray(declaredSection.values)
		) {
			throw new Error('Environment section values must be an object.');
		}
		environmentSectionEntries(declaredSection, true);
		if (sectionTitles.has(declaredSection.title)) {
			throw new Error(
				`Duplicate environment section title: ${declaredSection.title}`,
			);
		}
		sectionTitles.add(declaredSection.title);
	}
	assertEnvironmentRules(declaredSections, rules);

	function EnvironmentPanel({ onBack }: { onBack: () => void }) {
		const validationResults = validateEnvironmentValues(
			declaredSections,
			rules,
		);
		const failing = validationResults.filter(
			(result) => result.status !== 'valid',
		);
		const exportValue = sanitizeDiagnosticValue(
			Object.fromEntries(
				declaredSections.map((declared) => [declared.title, declared.values]),
			),
		);
		const shareManifest = () => {
			shareDiagnosticContent({
				message: serializeValue(exportValue, 512 * 1024).text,
				title,
			});
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
														{formatEnvironmentEntry(
															result.key,
															result.expectedValue,
														)}
													</UIText>
												</LabeledContent>
											) : null}
											<LabeledContent label="Actual">
												<UIText>
													{formatEnvironmentEntry(
														result.key,
														result.actualValue,
													)}
												</UIText>
											</LabeledContent>
										</DisclosureGroup>
									))}
								</Section>
							) : null}
							{declaredSections.map((declared) => {
								const entries = [...environmentSectionEntries(declared)].sort(
									([left], [right]) => left.localeCompare(right),
								);
								return (
									<Section key={declared.title} title={declared.title}>
										{entries.map(([key, value]) => (
											<LabeledContent
												key={key}
												label={formatEnvironmentKey(key)}
											>
												<UIText>{formatEnvironmentEntry(key, value)}</UIText>
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
				) : (
					<AndroidPanelScroll>
						{validationResults.length > 0 ? (
							<AndroidPanelSection title="Health">
								<AndroidPanelRow
									label={
										failing.length > 0
											? `${failing.length} checks failing`
											: 'All checks passing'
									}
									tone={failing.length > 0 ? 'warning' : 'success'}
								/>
								{failing.map((result) => (
									<AndroidPanelRow
										key={`${result.section ?? '*'}:${result.key}`}
										label={formatEnvironmentKey(result.key)}
										detail={result.description}
										tone="warning"
										value={validationLabel(result)}
									/>
								))}
							</AndroidPanelSection>
						) : null}
						{declaredSections.map((declared) => (
							<AndroidPanelSection key={declared.title} title={declared.title}>
								{[...environmentSectionEntries(declared)]
									.sort(([left], [right]) => left.localeCompare(right))
									.map(([key, value]) => (
										<AndroidPanelRow
											key={key}
											label={formatEnvironmentKey(key)}
											value={formatEnvironmentEntry(key, value)}
										/>
									))}
							</AndroidPanelSection>
						))}
					</AndroidPanelScroll>
				)}
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
