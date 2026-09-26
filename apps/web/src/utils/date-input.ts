// PROJ-875: one conversion pair between <input type="date"> strings ("YYYY-MM-DD") and
// the API's unix seconds. Both directions use LOCAL midnight, so a date typed in and
// read back is the same calendar day in every timezone. (`new Date("YYYY-MM-DD")`
// parses as UTC midnight, which read back through local getters shifts the date a day
// earlier anywhere west of UTC.)

/** "YYYY-MM-DD" → unix seconds at local midnight; empty/invalid → null. */
export function dateInputToUnix(value: string): number | null {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!m) return null;
	const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
}

/** unix seconds → "YYYY-MM-DD" in local time; null → "". */
export function unixToDateInput(ts: number | null | undefined): string {
	if (ts === null || ts === undefined) return "";
	const d = new Date(ts * 1000);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

/** unix seconds → a short locale date for display; null → "—". */
export function formatUnixDate(ts: number | null | undefined): string {
	if (ts === null || ts === undefined) return "—";
	return new Date(ts * 1000).toLocaleDateString();
}
