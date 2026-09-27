import { describe, expect, it } from "vitest";
import {
	type Budget,
	diffGroup,
	isFailingDelta,
	isWarningDelta,
	markdownSummary,
	stableChunkName,
	toStableSizes,
} from "../../../../scripts/bundle-budget-lib.ts";

// PROJ-841: unit coverage for the bundle-budget ratchet comparison logic, independent of
// a real apps/web/dist build. See scripts/bundle-budget.ts for the CLI wrapper.

const TOLERANCE = { toleranceRatio: 0.02, toleranceBytes: 1024 };

describe("stableChunkName", () => {
	it("strips a named chunk hash", () => {
		expect(stableChunkName("IssueList.BX52gRWz.js")).toBe("IssueList.js");
	});

	it("strips the trailing hash off an anonymous chunk, keeping its id prefix", () => {
		expect(stableChunkName("chunk-Y2CYZVJY.DsF7k-Jl.js")).toBe("chunk-Y2CYZVJY.js");
	});

	it("leaves a file with no hash segment untouched", () => {
		expect(stableChunkName("global.css")).toBe("global.css");
	});
});

describe("toStableSizes", () => {
	it("sums sizes when two files collapse to the same stable name", () => {
		const out = toStableSizes({ "a.HASH1.js": 100, "a.HASH2.js": 50, "b.HASH3.js": 10 });
		expect(out).toEqual({ "a.js": 150, "b.js": 10 });
	});
});

describe("diffGroup ratchet rule", () => {
	it("passes a chunk that grew within the 2%/1KB tolerance", () => {
		// 100 KiB baseline, 2% = ~2 KiB allowed; grow by 1 KiB.
		const baseline = { "x.js": 100 * 1024 };
		const current = { "x.js": 101 * 1024 };
		const [d] = diffGroup("initial", baseline, current, TOLERANCE);
		expect(d.verdict).toBe("ok");
		expect(isFailingDelta(d)).toBe(false);
	});

	it("fails a chunk that grew past the tolerance", () => {
		const baseline = { "x.js": 100 * 1024 };
		const current = { "x.js": 110 * 1024 }; // +10 KiB, way past max(2%, 1KB)
		const [d] = diffGroup("initial", baseline, current, TOLERANCE);
		expect(d.verdict).toBe("grew");
		expect(isFailingDelta(d)).toBe(true);
	});

	it("applies the absolute 1 KB floor even for a tiny baseline", () => {
		// 2% of 1 KiB baseline is ~20 bytes; a 900-byte growth should still pass under the
		// 1 KiB absolute floor.
		const baseline = { "tiny.js": 1024 };
		const current = { "tiny.js": 1024 + 900 };
		const [d] = diffGroup("initial", baseline, current, TOLERANCE);
		expect(d.verdict).toBe("ok");
	});

	it("fails a brand-new eager chunk with no baseline entry", () => {
		const [d] = diffGroup("initial", {}, { "new.js": 5000 }, TOLERANCE);
		expect(d.verdict).toBe("new-eager-no-baseline");
		expect(isFailingDelta(d)).toBe(true);
	});

	it("does NOT fail a brand-new lazy chunk with no baseline entry", () => {
		const [d] = diffGroup("lazy", {}, { "newDiagram.js": 5000 }, TOLERANCE);
		expect(d.verdict).toBe("new-lazy");
		expect(isFailingDelta(d)).toBe(false);
	});

	it("never fails a chunk that shrank or stayed the same", () => {
		const baseline = { "a.js": 1000, "b.js": 1000 };
		const current = { "a.js": 900, "b.js": 1000 };
		const deltas = diffGroup("initial", baseline, current, TOLERANCE);
		expect(deltas.every((d) => !isFailingDelta(d))).toBe(true);
	});

	it("reports a removed chunk without failing", () => {
		const [d] = diffGroup("initial", { "gone.js": 1000 }, {}, TOLERANCE);
		expect(d.verdict).toBe("removed");
		expect(isFailingDelta(d)).toBe(false);
	});

	it("has no override mechanism — a big growth always fails (PROJ-841 review)", () => {
		// diffGroup only takes (group, baseline, current, options) — there is nothing left
		// to pass that would suppress a failing verdict. This test exists so that adding an
		// override parameter back would have to consciously break this assertion.
		expect(diffGroup.length).toBe(4);
	});

	it("warns, but does not fail, when a chunk shrinks well past the tolerance", () => {
		// 100 KiB baseline, 2%/1KiB tolerance = ~2 KiB; shrink by 50 KiB.
		const baseline = { "x.js": 100 * 1024 };
		const current = { "x.js": 50 * 1024 };
		const [d] = diffGroup("initial", baseline, current, TOLERANCE);
		expect(d.verdict).toBe("shrank-past-tolerance");
		expect(isWarningDelta(d)).toBe(true);
		expect(isFailingDelta(d)).toBe(false);
	});

	it("does not warn on a small shrink within tolerance", () => {
		const baseline = { "x.js": 100 * 1024 };
		const current = { "x.js": 100 * 1024 - 500 };
		const [d] = diffGroup("initial", baseline, current, TOLERANCE);
		expect(d.verdict).toBe("shrank");
		expect(isWarningDelta(d)).toBe(false);
	});
});

describe("end-to-end Budget diff (proves the ratchet catches a real regression)", () => {
	it("fails the whole comparison when one initial chunk regresses", () => {
		const baseline: Budget = { initial: { "IssueList.js": 10000 }, lazy: {} };
		const currentGood: Budget = { initial: { "IssueList.js": 10100 }, lazy: {} };
		const currentBad: Budget = { initial: { "IssueList.js": 20000 }, lazy: {} };

		const goodDeltas = diffGroup("initial", baseline.initial, currentGood.initial, TOLERANCE);
		expect(goodDeltas.some(isFailingDelta)).toBe(false);

		const badDeltas = diffGroup("initial", baseline.initial, currentBad.initial, TOLERANCE);
		expect(badDeltas.some(isFailingDelta)).toBe(true);
	});
});

describe("markdownSummary", () => {
	it("omits unchanged chunks but keeps a count of them", () => {
		const deltas = diffGroup("initial", { "a.js": 1000 }, { "a.js": 1000 }, TOLERANCE);
		const md = markdownSummary(deltas);
		expect(md).toContain("unchanged chunk(s) omitted");
		expect(md).not.toContain("`a.js`");
	});

	it("includes a row for a chunk that grew", () => {
		const deltas = diffGroup("initial", { "a.js": 1000 }, { "a.js": 50000 }, TOLERANCE);
		const md = markdownSummary(deltas);
		expect(md).toContain("`a.js`");
		expect(md).toContain("grew");
	});
});
