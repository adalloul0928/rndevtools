import { Button, Section, Text } from '@expo/ui/swift-ui';
import { useState } from 'react';
import { Platform } from 'react-native';
import { AndroidPanelRow, AndroidPanelSection } from './android-panel-ui';

const PAGE_SIZE = 100;

export function useEventPage<T>(items: readonly T[], filterKey: string) {
	const [selection, setSelection] = useState({ key: filterKey, index: 0 });
	const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
	const index =
		selection.key === filterKey ? Math.min(selection.index, pageCount - 1) : 0;
	// Keep a filter change or a shrinking retained history from restoring an old page later.
	if (selection.key !== filterKey || selection.index !== index) {
		setSelection({ key: filterKey, index });
	}
	const start = index * PAGE_SIZE;
	return {
		items: items.slice(start, start + PAGE_SIZE),
		label: `Showing ${start + 1}–${Math.min(start + PAGE_SIZE, items.length)} of ${items.length}`,
		previous:
			index > 0
				? () => setSelection({ key: filterKey, index: index - 1 })
				: undefined,
		next:
			index + 1 < pageCount
				? () => setSelection({ key: filterKey, index: index + 1 })
				: undefined,
	};
}

type PageControls = Pick<
	ReturnType<typeof useEventPage>,
	'label' | 'previous' | 'next'
>;

export function EventPageControls({ label, previous, next }: PageControls) {
	if (!previous && !next) return null;
	if (Platform.OS === 'ios') {
		return (
			<Section>
				<Text>{label}</Text>
				{previous ? <Button label="Previous page" onPress={previous} /> : null}
				{next ? <Button label="Next page" onPress={next} /> : null}
			</Section>
		);
	}
	return (
		<AndroidPanelSection title={label}>
			{previous ? (
				<AndroidPanelRow label="Previous page" onPress={previous} />
			) : null}
			{next ? <AndroidPanelRow label="Next page" onPress={next} /> : null}
		</AndroidPanelSection>
	);
}
