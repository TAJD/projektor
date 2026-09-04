// MetricsDashboard island — mock-fetch tests.
//
// Follows the SprintManager.test.tsx pattern: reads ?projectId= from the URL, then fetches
// /api/projects/:id/flow-metrics via raw fetch + buildHeaders. loading starts as true.
import { fireEvent, render, screen, within } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MetricsDashboard from "./MetricsDashboard";

const EMPTY_METRICS = {
	leadTime: { count: 0, avg: null, p50: null, p90: null },
	cycleTime: { count: 0, avg: null, p50: null, p90: null },
	wipOverTime: [],
	throughputOverTime: [],
	bugShareOverTime: [],
	bugTypeTracked: true,
	reviewLatency: { count: 0, avg: null, p50: null, p90: null },
	reviewLatencyOverTime: [],
	humanInterventions: { count: 0, avg: null, p50: null, p90: null },
	autonomyRatio: { count: 0, avg: null, p50: null, p90: null },
	cfdOverTime: [],
	timeInProgress: { count: 0, avg: null, p50: null, p90: null },
	arrivalVsCompletionOverTime: [],
	flowEfficiency: { count: 0, avg: null, p50: null, p90: null },
	agingWip: [],
	factoryHealth: { leaseExpiries: 0, abandonedClaims: 0, gateRejections: 0, wipCapPressure: 0 },
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
		{ bucketStart: "2026-05-25", count: 0 },
		{ bucketStart: "2026-06-01", count: 0 },
	],
	bugShareOverTime: [
		{ bucketStart: "2026-05-25", total: 0, bugCount: 0, bugSharePercent: null },
		{ bucketStart: "2026-06-01", total: 0, bugCount: 0, bugSharePercent: null },
	],
	bugTypeTracked: true,
	reviewLatency: { count: 0, avg: null, p50: null, p90: null },
	reviewLatencyOverTime: [
		{ bucketStart: "2026-05-25", p50: null },
		{ bucketStart: "2026-06-01", p50: null },
	],
	humanInterventions: { count: 0, avg: null, p50: null, p90: null },
	autonomyRatio: { count: 0, avg: null, p50: null, p90: null },
	cfdOverTime: [
		{ bucketStart: "2026-05-25", backlogTodo: 0, inProgress: 0, inReview: 0, done: 0 },
		{ bucketStart: "2026-06-01", backlogTodo: 0, inProgress: 0, inReview: 0, done: 0 },
	],
	timeInProgress: { count: 0, avg: null, p50: null, p90: null },
	arrivalVsCompletionOverTime: [
		{ bucketStart: "2026-05-25", created: 0, completed: 0, net: 0 },
		{ bucketStart: "2026-06-01", created: 0, completed: 0, net: 0 },
	],
	flowEfficiency: { count: 0, avg: null, p50: null, p90: null },
	agingWip: [],
	factoryHealth: { leaseExpiries: 0, abandonedClaims: 0, gateRejections: 0, wipCapPressure: 0 },
};

const FULL_METRICS = {
	leadTime: { count: 4, avg: 86400 * 2.3, p50: 86400 * 2, p90: 86400 * 4 },
	cycleTime: { count: 4, avg: 3600 * 5, p50: 3600 * 4, p90: 3600 * 9 },
	wipOverTime: [
		{ date: "2026-06-01", count: 2 },
		{ date: "2026-06-02", count: 3 },
	],
	throughputOverTime: [
		{ bucketStart: "2026-05-25", count: 1 },
		{ bucketStart: "2026-06-01", count: 3 },
	],
	bugShareOverTime: [
		{ bucketStart: "2026-05-25", total: 1, bugCount: 0, bugSharePercent: 0 },
		{ bucketStart: "2026-06-01", total: 3, bugCount: 1, bugSharePercent: 1 / 3 },
	],
	bugTypeTracked: true,
	reviewLatency: { count: 4, avg: 3600 * 3, p50: 3600 * 2, p90: 3600 * 6 },
	reviewLatencyOverTime: [
		{ bucketStart: "2026-05-25", p50: 3600 * 2 },
		{ bucketStart: "2026-06-01", p50: 3600 * 3 },
	],
	humanInterventions: { count: 4, avg: 1.5, p50: 1, p90: 3 },
	autonomyRatio: { count: 4, avg: 0.6, p50: 0.65, p90: 0.9 },
	cfdOverTime: [
		{ bucketStart: "2026-05-25", backlogTodo: 2, inProgress: 1, inReview: 0, done: 1 },
		{ bucketStart: "2026-06-01", backlogTodo: 1, inProgress: 1, inReview: 1, done: 2 },
	],
	timeInProgress: { count: 4, avg: 3600 * 4, p50: 3600 * 3, p90: 3600 * 8 },
	arrivalVsCompletionOverTime: [
		{ bucketStart: "2026-05-25", created: 2, completed: 1, net: 1 },
		{ bucketStart: "2026-06-01", created: 1, completed: 3, net: -2 },
	],
	flowEfficiency: { count: 4, avg: 0.4, p50: 0.35, p90: 0.7 },
	agingWip: [
		{ id: "issue-1", status: "in_progress", ageSeconds: 86400 * 12 },
		{ id: "issue-2", status: "in_review", ageSeconds: 86400 * 3 },
	],
	factoryHealth: { leaseExpiries: 2, abandonedClaims: 1, gateRejections: 3, wipCapPressure: 4 },
};

const EMPTY_CODE_HEATMAP = { prefix: "", totalDistinctIssues: 0, entries: [] };

function mockFetchMetrics(metrics: unknown) {
	const fetchMock = vi.fn().mockImplementation((url: string) => {
		const u = String(url);
		if (u.includes("/flow-metrics")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(metrics) });
		}
		if (u.includes("/code-heatmap")) {
			return Promise.resolve({ ok: true, json: () => Promise.resolve(EMPTY_CODE_HEATMAP) });
		}
		return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
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

	it("renders throughput, lead/cycle tiles after fetch resolves", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);

		expect(await screen.findByText("Throughput")).toBeTruthy();
		expect(screen.getByText("Bug share")).toBeTruthy();
		expect(screen.getByText("Lead time")).toBeTruthy();
		expect(screen.getByText("Cycle time")).toBeTruthy();
		expect(screen.getByText("WIP over time")).toBeTruthy();
		expect(screen.getByText("Arrival vs completion")).toBeTruthy();
		expect(screen.getByText("Flow efficiency")).toBeTruthy();
		expect(screen.getByText("40%")).toBeTruthy();
		expect(screen.getByText("Aging WIP")).toBeTruthy();
	});

	it("renders factory health tiles with nonzero counts", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);

		const heading = await screen.findByText("Factory health");
		const section = within(heading.closest("section") as HTMLElement);
		expect(section.getByText("Lease expiries")).toBeTruthy();
		expect(section.getByText("2")).toBeTruthy();
		expect(section.getByText("Abandoned claims")).toBeTruthy();
		expect(section.getByText("1")).toBeTruthy();
		expect(section.getByText("Gate rejections")).toBeTruthy();
		expect(section.getByText("3")).toBeTruthy();
		expect(section.getByText(/WIP-cap pressure/i)).toBeTruthy();
		expect(section.getByText("4")).toBeTruthy();
	});

	it("shows a zero empty state for factory health when nothing has faulted", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(ZERO_BUCKET_METRICS);
		render(<MetricsDashboard />);

		const heading = await screen.findByText("Factory health");
		const section = within(heading.closest("section") as HTMLElement);
		expect(section.getAllByText("0")).toHaveLength(4);
	});

	it("shows the code-heatmap empty state fed by claim_files", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);

		expect(await screen.findByText("Where work lands")).toBeTruthy();
		expect(await screen.findByText(/No file claims in this window yet/i)).toBeTruthy();
		expect(screen.getByText(/claim_files/i)).toBeTruthy();
	});

	// Both ThroughputChart and BugShareChart render the same empty-state message.
	async function expectEmptyChartStates() {
		expect(await screen.findByText("Throughput")).toBeTruthy();
		expect(screen.getAllByText(/No completed issues yet/i)).toHaveLength(2);
		expect(screen.getByText(/No WIP data yet/i)).toBeTruthy();
		expect(screen.getByText(/No arrivals or completions yet/i)).toBeTruthy();
		expect(screen.getByText(/No issues currently in progress or review/i)).toBeTruthy();
	}

	it("does not crash on an empty-metrics response", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(EMPTY_METRICS);
		render(<MetricsDashboard />);

		await expectEmptyChartStates();
	});

	it("shows empty-chart states for a fixed-size all-zero bucket window (real API shape)", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(ZERO_BUCKET_METRICS);
		render(<MetricsDashboard />);

		await expectEmptyChartStates();
	});

	it("shows a message when no project is specified", async () => {
		render(<MetricsDashboard />);
		expect(await screen.findByText(/No project specified/i)).toBeTruthy();
	});

	it("falls back to the stored project id when no URL param is present, matching ProjectNav (PROJ-723)", async () => {
		localStorage.setItem("projektor-last-project-id", "p1");
		mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);
		expect(await screen.findByText("Throughput")).toBeTruthy();
		localStorage.removeItem("projektor-last-project-id");
	});

	it("renders a help icon per stat/chart section and shows the definitions-map popover on click", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);
		await screen.findByText("Throughput");

		// Every StatTile/DistributionTiles/chart-header group on the dashboard renders an
		// "About <label>" trigger backed by the shared metric-definitions.ts map.
		const trigger = screen.getByRole("button", { name: "About Cycle time" });
		expect(trigger.getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(trigger);

		const popover = screen.getByRole("dialog", { name: "Cycle time definition" });
		expect(popover).toBeTruthy();
		expect(popover.textContent).toMatch(/done − claimed/i);
		// aria-describedby on the trigger associates it with the now-open popover.
		expect(trigger.getAttribute("aria-expanded")).toBe("true");
		expect(trigger.getAttribute("aria-describedby")).toBe(popover.id);
		expect(popover.getAttribute("aria-modal")).toBe("false");

		// A large sample of the dashboard's other tiles/charts also get a trigger, not just
		// one — spot-check a few spanning different sections (factory health, a chart-only
		// header, a formatted-percent distribution).
		expect(screen.getByRole("button", { name: "About Lease expiries" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "About Bug share" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "About Autonomy ratio" })).toBeTruthy();
		expect(screen.getByRole("button", { name: "About Aging WIP" })).toBeTruthy();
	});

	it("dismisses the help popover on Escape and returns to a closed state", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);
		await screen.findByText("Throughput");

		const trigger = screen.getByRole("button", { name: "About Lead time" });
		fireEvent.click(trigger);
		expect(screen.getByRole("dialog", { name: "Lead time definition" })).toBeTruthy();

		fireEvent.keyDown(document, { key: "Escape" });

		expect(screen.queryByRole("dialog", { name: "Lead time definition" })).toBeNull();
		expect(trigger.getAttribute("aria-expanded")).toBe("false");
	});

	it("dismisses the help popover on an outside click", async () => {
		history.replaceState(null, "", "?projectId=p1");
		mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);
		await screen.findByText("Throughput");

		const trigger = screen.getByRole("button", { name: "About Throughput" });
		fireEvent.click(trigger);
		expect(screen.getByRole("dialog", { name: "Throughput definition" })).toBeTruthy();

		fireEvent.mouseDown(document.body);

		expect(screen.queryByRole("dialog", { name: "Throughput definition" })).toBeNull();
	});

	it("renders range controls and defaults to a 6-week weekly window", async () => {
		history.replaceState(null, "", "?projectId=p1");
		const fetchMock = mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);
		await screen.findByText("Throughput");

		expect(screen.getByLabelText("From date")).toBeTruthy();
		expect(screen.getByLabelText("To date")).toBeTruthy();
		expect(screen.getByLabelText("Chart granularity")).toBeTruthy();

		const lastCall = fetchMock.mock.calls.at(-1);
		const requestedUrl = new URL(String(lastCall?.[0]), "http://localhost");
		const since = Number(requestedUrl.searchParams.get("since"));
		const until = Number(requestedUrl.searchParams.get("until"));
		expect(requestedUrl.searchParams.get("granularity")).toBe("week");
		// Window spans from Monday of 5 weeks ago through today: between 5 and 6 weeks.
		expect(until - since).toBeGreaterThanOrEqual(5 * 7 * 86400);
		expect(until - since).toBeLessThanOrEqual(6 * 7 * 86400 + 86400);

		const params = new URLSearchParams(window.location.search);
		expect(params.get("granularity")).toBe("week");
		expect(params.get("since")).toBeTruthy();
		expect(params.get("until")).toBeTruthy();
	});

	it("refetches with granularity=day and updates the URL when the toggle changes", async () => {
		history.replaceState(null, "", "?projectId=p1");
		const fetchMock = mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);
		await screen.findByText("Throughput");

		fireEvent.click(screen.getByLabelText("Chart granularity"));
		fireEvent.click(await screen.findByRole("option", { name: "Daily" }));

		await screen.findByText("Throughput");
		const lastCall = fetchMock.mock.calls.at(-1);
		const requestedUrl = new URL(String(lastCall?.[0]), "http://localhost");
		expect(requestedUrl.searchParams.get("granularity")).toBe("day");
		expect(new URLSearchParams(window.location.search).get("granularity")).toBe("day");
	});

	it("refetches with the updated date when the From input changes", async () => {
		history.replaceState(null, "", "?projectId=p1");
		const fetchMock = mockFetchMetrics(FULL_METRICS);
		render(<MetricsDashboard />);
		await screen.findByText("Throughput");

		fireEvent.input(screen.getByLabelText("From date"), { target: { value: "2026-01-01" } });

		await screen.findByText("Throughput");
		const lastCall = fetchMock.mock.calls.at(-1);
		const requestedUrl = new URL(String(lastCall?.[0]), "http://localhost");
		expect(requestedUrl.searchParams.get("since")).toBe(
			String(Date.parse("2026-01-01T00:00:00Z") / 1000)
		);
		expect(new URLSearchParams(window.location.search).get("since")).toBe("2026-01-01");
	});
});
