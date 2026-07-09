// MetricsDashboard island — mock-fetch tests.
//
// Follows the SprintManager.test.tsx pattern: reads ?projectId= from the URL, then fetches
// /api/projects/:id/flow-metrics via raw fetch + buildHeaders. loading starts as true.
import { render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MetricsDashboard from "./MetricsDashboard";

const EMPTY_METRICS = {
	leadTime: { count: 0, avg: null, p50: null, p90: null },
	cycleTime: { count: 0, avg: null, p50: null, p90: null },
	wipOverTime: [],
	throughputOverTime: [],
	agentVsHuman: {
		agent: { count: 0, avg: null, p50: null, p90: null },
		human: { count: 0, avg: null, p50: null, p90: null },
	},
};

// The real API always returns a fixed-size bucket window, even with zero completions —
// it never returns [] for an active project. This is the actual "no data" shape.
const ZERO_BUCKET_METRICS = {
	leadTime: { count: 0, avg: null, p50: null, p90: null },
	cycleTime: { count: 0, avg: null, p50: null, p90: null },
	wipOverTime: [
		{ date: "2026-06-01", count: 0 },
		{ date: "2026-06-02", count: 0 },
	],
	throughputOverTime: [
		{ weekStart: "2026-05-25", count: 0 },
		{ weekStart: "2026-06-01", count: 0 },
	],
	agentVsHuman: {
		agent: { count: 0, avg: null, p50: null, p90: null },
		human: { count: 0, avg: null, p50: null, p90: null },
	},
};

const FULL_METRICS = {
	leadTime: { count: 4, avg: 86400 * 2.3, p50: 86400 * 2, p90: 86400 * 4 },
	cycleTime: { count: 4, avg: 3600 * 5, p50: 3600 * 4, p90: 3600 * 9 },
	wipOverTime: [
		{ date: "2026-06-01", count: 2 },
		{ date: "2026-06-02", count: 3 },
	],
	throughputOverTime: [
		{ weekStart: "2026-05-25", count: 1 },
		{ weekStart: "2026-06-01", count: 3 },
	],
	agentVsHuman: {
		agent: { count: 2, avg: 3600 * 3, p50: 3600 * 2, p90: 3600 * 6 },
		human: { count: 2, avg: 3600 * 7, p50: 3600 * 6, p90: 3600 * 12 },
	},
};

function mockFetchMetrics(metrics: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn().mockImplementation((url: string) => {
			const u = String(url);
			if (u.includes("/flow-metrics")) {
				return Promise.resolve({ ok: true, json: () => Promise.resolve(metrics) });
			}
			return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		})
	);
}

beforeEach(() => {
	history.replaceState(null, "", "/");
});

afterEach(() => {
	history.replaceState(null, "", "/");
});

describe("MetricsDashboard", () => {
	it("renders loading state initially", () => {
		history.replaceState(null, "", "?projectId=p1");
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(() => new Promise(() => {}))
		);
		render(<MetricsDashboard />);
		expect(screen.getByText(/Loading metrics/i)).toBeTruthy();
	});

	it("renders throughput, lead/cycle tiles, and agent-vs-human after fetch resolves", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);

		expect(await screen.findByText("Throughput")).toBeTruthy();
		expect(screen.getByText("Lead time")).toBeTruthy();
		expect(screen.getByText("Cycle time")).toBeTruthy();
		expect(screen.getByText("WIP over time")).toBeTruthy();
		expect(screen.getByText("Agent vs human")).toBeTruthy();
	});

	it("does not crash on an empty-metrics response", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(EMPTY_METRICS);
		render(<MetricsDashboard />);

		expect(await screen.findByText("Throughput")).toBeTruthy();
		expect(screen.getByText(/No completed issues yet/i)).toBeTruthy();
		expect(screen.getByText(/No WIP data yet/i)).toBeTruthy();
	});

	it("shows empty-chart states for a fixed-size all-zero bucket window (real API shape)", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(ZERO_BUCKET_METRICS);
		render(<MetricsDashboard />);

		expect(await screen.findByText("Throughput")).toBeTruthy();
		expect(screen.getByText(/No completed issues yet/i)).toBeTruthy();
		expect(screen.getByText(/No WIP data yet/i)).toBeTruthy();
	});

	it("shows a message when no project is specified", async () => {
		render(<MetricsDashboard />);
		expect(await screen.findByText(/No project specified/i)).toBeTruthy();
	});
});
