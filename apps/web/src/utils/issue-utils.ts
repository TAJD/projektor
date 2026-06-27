export const PRIORITY_OPTIONS = (["urgent", "high", "medium", "low", "none"] as const).map(
	(p) => ({ value: p, label: p })
);
