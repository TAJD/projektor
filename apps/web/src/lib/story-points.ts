export function parseStoryPoints(value: string): number | null {
	if (value === "") return null;
	const num = parseFloat(value);
	if (Number.isNaN(num)) return null;
	return num;
}
