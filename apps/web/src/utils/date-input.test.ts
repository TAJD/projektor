// PROJ-875: date input <-> unix seconds round-trips to the same calendar day in any TZ.
import { afterEach, describe, expect, it } from "vitest";
import { dateInputToUnix, formatUnixDate, unixToDateInput } from "./date-input";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
	process.env.TZ = ORIGINAL_TZ;
});

describe("date-input helpers", () => {
	it.each(["America/Los_Angeles", "Asia/Tokyo", "UTC", "Europe/Rome"])(
		"round-trips a date unchanged in %s",
		(tz) => {
			process.env.TZ = tz;
			for (const day of ["2026-09-23", "2026-01-01", "2026-12-31", "2026-03-29"]) {
				const ts = dateInputToUnix(day);
				expect(ts).not.toBeNull();
				expect(unixToDateInput(ts)).toBe(day);
				// a second save of the displayed value is stable (no drift per edit)
				expect(dateInputToUnix(unixToDateInput(ts))).toBe(ts);
			}
		}
	);

	it("rejects empty/garbage input", () => {
		expect(dateInputToUnix("")).toBeNull();
		expect(dateInputToUnix("23/09/2026")).toBeNull();
		expect(unixToDateInput(null)).toBe("");
	});

	it("formats unix seconds, not milliseconds (no 1970)", () => {
		const ts = dateInputToUnix("2026-09-23") as number;
		expect(formatUnixDate(ts)).not.toMatch(/1970/);
		expect(formatUnixDate(null)).toBe("—");
	});
});
