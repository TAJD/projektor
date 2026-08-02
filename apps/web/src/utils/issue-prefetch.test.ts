import { afterEach, describe, expect, it, vi } from "vitest";
import { claimPrefetchedIssue } from "./issue-prefetch";

const HANDOFF = "__projektorIssuePrefetch";

function setHandoff(key: string, t: number, response: Promise<Response | null>) {
	(window as unknown as Record<string, unknown>)[HANDOFF] = { key, t, response };
}

afterEach(() => {
	delete (window as unknown as Record<string, unknown>)[HANDOFF];
	vi.useRealTimers();
});

describe("claimPrefetchedIssue", () => {
	it("returns null when there is no handoff", () => {
		expect(claimPrefetchedIssue("PROJ-1")).toBeNull();
	});

	it("returns null when the handoff key doesn't match", () => {
		setHandoff("PROJ-2", Date.now(), Promise.resolve(null));
		expect(claimPrefetchedIssue("PROJ-1")).toBeNull();
	});

	it("returns null when the handoff is older than the freshness bound", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		setHandoff("PROJ-1", 0, Promise.resolve(null));
		vi.setSystemTime(20_000);
		expect(claimPrefetchedIssue("PROJ-1")).toBeNull();
	});

	it("removes the handoff after a matching claim (single-use)", () => {
		setHandoff(
			"PROJ-1",
			Date.now(),
			Promise.resolve(new Response(JSON.stringify({ id: "PROJ-1" })))
		);
		claimPrefetchedIssue("PROJ-1");
		expect((window as unknown as Record<string, unknown>)[HANDOFF]).toBeUndefined();
	});

	it("resolves with the parsed JSON body for a fresh, matching, ok response", async () => {
		setHandoff(
			"PROJ-1",
			Date.now(),
			Promise.resolve(new Response(JSON.stringify({ id: "PROJ-1" })))
		);
		const result = await claimPrefetchedIssue<{ id: string }>("PROJ-1");
		expect(result).toEqual({ id: "PROJ-1" });
	});

	it("rejects when the prefetch response was not ok", async () => {
		setHandoff("PROJ-1", Date.now(), Promise.resolve(new Response(null, { status: 500 })));
		await expect(claimPrefetchedIssue("PROJ-1")).rejects.toThrow("issue prefetch missed");
	});

	it("rejects when the prefetch itself failed (null response)", async () => {
		setHandoff("PROJ-1", Date.now(), Promise.resolve(null));
		await expect(claimPrefetchedIssue("PROJ-1")).rejects.toThrow("issue prefetch missed");
	});
});
