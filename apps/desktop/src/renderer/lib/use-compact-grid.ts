import { useLayoutEffect, useState } from 'react';

/** Measure the list pane, including changes caused by hiding the sidebar. */
export function useCompactGrid() {
	const [pane, setPane] = useState<HTMLDivElement | null>(null);
	const [compact, setCompact] = useState(true);
	useLayoutEffect(() => {
		if (!pane) return;
		const measure = () => setCompact(pane.clientWidth < 840);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(pane);
		return () => observer.disconnect();
	}, [pane]);
	return { gridPaneRef: setPane, compact };
}
