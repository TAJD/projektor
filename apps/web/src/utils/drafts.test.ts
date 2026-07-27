import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAllDrafts, clearDraft, draftKey, loadDraft, saveDraft } from "./drafts";

describe("drafts (PROJ-431)", () => {
	beforeEach(() => {
		localStorage.clear();
		vi.useRealTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("round-trips a draft", () => {
		const k = draftKey("projektor", "issue-1", "comment");
		saveDraft(k, "half a thought");
		expect(loadDraft(k)).toBe("half a thought");
	});

	it("returns null when there is no draft", () => {
		expect(loadDraft(draftKey("projektor", "issue-1", "comment"))).toBeNull();
	});

	// Cached *fetched* data is deliberately not persisted; drafts are the user's own
	// unsent input. Tenant scoping still has to hold so text can't surface elsewhere.
	it("scopes keys by workspace so one workspace's draft can't surface in another", () => {
		const a = draftKey("alpha", "issue-1", "comment");
		const b = draftKey("beta", "issue-1", "comment");
		expect(a).not.toBe(b);
		saveDraft(a, "alpha text");
		expect(loadDraft(b)).toBeNull();
	});

	it("keys distinct fields on the same issue separately", () => {
		const c = draftKey("projektor", "issue-1", "comment");
		const b = draftKey("projektor", "issue-1", "body");
		saveDraft(c, "a comment");
		saveDraft(b, "a body");
		expect(loadDraft(c)).toBe("a comment");
		expect(loadDraft(b)).toBe("a body");
	});

	it("treats an empty or whitespace-only value as a clear", () => {
		const k = draftKey("projektor", "issue-1", "comment");
		saveDraft(k, "something");
		saveDraft(k, "   ");
		expect(loadDraft(k)).toBeNull();
		expect(localStorage.getItem(k)).toBeNull();
	});

	it("expires drafts older than 7 days, and removes the entry", () => {
		const k = draftKey("projektor", "issue-1", "comment");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
		saveDraft(k, "stale");
		vi.setSystemTime(new Date("2026-07-08T00:00:01Z"));
		expect(loadDraft(k)).toBeNull();
		expect(localStorage.getItem(k)).toBeNull();
	});

	it("keeps a draft that is just inside the 7-day window", () => {
		const k = draftKey("projektor", "issue-1", "comment");
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-07-01T00:00:00Z"));
		saveDraft(k, "fresh enough");
		vi.setSystemTime(new Date("2026-07-07T23:00:00Z"));
		expect(loadDraft(k)).toBe("fresh enough");
	});

	it("discards a malformed entry instead of throwing", () => {
		const k = draftKey("projektor", "issue-1", "comment");
		localStorage.setItem(k, "not json");
		expect(loadDraft(k)).toBeNull();
	});

	it("clearAllDrafts removes drafts but leaves unrelated keys alone", () => {
		saveDraft(draftKey("projektor", "issue-1", "comment"), "one");
		saveDraft(draftKey("other", "issue-2", "body"), "two");
		localStorage.setItem("theme", "dark");
		clearAllDrafts();
		expect(loadDraft(draftKey("projektor", "issue-1", "comment"))).toBeNull();
		expect(loadDraft(draftKey("other", "issue-2", "body"))).toBeNull();
		expect(localStorage.getItem("theme")).toBe("dark");
	});

	it("clearDraft removes a single entry", () => {
		const k = draftKey("projektor", "issue-1", "comment");
		saveDraft(k, "x");
		clearDraft(k);
		expect(loadDraft(k)).toBeNull();
	});

	// Private mode / quota. Persistence is a convenience, never a precondition for editing.
	it("degrades silently when storage throws", () => {
		const k = draftKey("projektor", "issue-1", "comment");
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("QuotaExceededError");
		});
		expect(() => saveDraft(k, "x")).not.toThrow();
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		expect(loadDraft(k)).toBeNull();
	});
});
