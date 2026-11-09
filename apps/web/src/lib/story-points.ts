/**
 * Parses a story-points field. The field is a plain text input (GOV.UK pattern: no
 * `type="number"`, whose scroll-wheel nudging and `e`/`+` acceptance cause silent
 * mistakes), so this is the validator: the whole string must be a number. Returns
 * null for empty (cleared) or invalid input; callers tell the two apart by `value`.
 */
export function parseStoryPoints(value: string): number | null {
	const trimmed = value.trim();
	if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
	return Number(trimmed);
}
