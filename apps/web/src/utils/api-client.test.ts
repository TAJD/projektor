import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetApiFetchStateForTests,
	ApiError,
	ApiOfflineError,
	apiFetch,
	SessionExpiredError,
} from "./api-client";

describe("apiFetch", () => {
	beforeEach(() => {
		sessionStorage.clear();
		__resetApiFetchStateForTests();
	});

	it("returns parsed JSON on a successful response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "i1" }) })
		);

		await expect(apiFetch("/api/issues/i1")).resolves.toEqual({ id: "i1" });
	});

	it("throws a plain Error on an HTTP error response", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

		await expect(apiFetch("/api/issues/i1")).rejects.toThrow(/404/);
	});

	// PROJ-602: a ValidationError from the service layer reaches the client as
	// `{ error: { formErrors: [...] } }` (http/error-adapter.ts) — without reading it,
	// every caller only ever saw the generic status code, never why the request failed.
	// `message` deliberately keeps its original `failed: <status>` shape (WikiPage's
	// 409/404 handling and ShareView's 404 handling pattern-match on it) — the parsed
	// reason is carried separately on `.detail` for callers that want to show it.
	it("carries a service-layer formErrors message on ApiError.detail, without changing .message", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 400,
				json: () =>
					Promise.resolve({
						error: { formErrors: ["Cannot change type: this epic still has child issues"] },
					}),
			})
		);

		await expect(apiFetch("/api/issues/i1", { method: "PATCH" })).rejects.toMatchObject({
			message: "API PATCH /api/issues/i1 failed: 400",
			status: 400,
			detail: "Cannot change type: this epic still has child issues",
		});
	});

	it("carries a plain string error body on ApiError.detail", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 404,
				json: () => Promise.resolve({ error: "Wiki page not found" }),
			})
		);

		await expect(apiFetch("/api/issues/i1")).rejects.toMatchObject({
			detail: "Wiki page not found",
		});
	});

	it("falls back to the status code as detail when the error body has no formErrors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({
				ok: false,
				status: 500,
				json: () => Promise.resolve({}),
			})
		);

		await expect(apiFetch("/api/issues/i1")).rejects.toMatchObject({
			message: "API GET /api/issues/i1 failed: 500",
			detail: "500",
		});
	});

	it("throws an ApiError instance on any HTTP error response", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));

		await expect(apiFetch("/api/issues/i1")).rejects.toBeInstanceOf(ApiError);
	});

	it("throws ApiOfflineError when fetch itself rejects (network failure)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

		await expect(apiFetch("/api/issues/i1", { method: "POST" })).rejects.toBeInstanceOf(
			ApiOfflineError
		);
	});

	it("reloads the page and never settles on a 401 (expired Cloudflare Access session)", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
		const reload = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...originalLocation, reload },
		});

		let settled = false;
		apiFetch("/api/issues/i1").then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			}
		);
		await new Promise((r) => setTimeout(r, 0));

		expect(reload).toHaveBeenCalledTimes(1);
		expect(settled).toBe(false);
		Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
	});

	it("suppresses errors from other in-flight calls once a 401 has triggered a reload", async () => {
		const reload = vi.fn();
		const originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...originalLocation, reload },
		});

		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
		apiFetch("/api/issues/i1");
		await new Promise((r) => setTimeout(r, 0));
		expect(reload).toHaveBeenCalledTimes(1);

		// A concurrent request aborted by the same navigation (network error) or
		// failing for any other reason shouldn't surface — the page is unloading.
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
		let networkErrorSettled = false;
		apiFetch("/auth/me").then(
			() => {
				networkErrorSettled = true;
			},
			() => {
				networkErrorSettled = true;
			}
		);

		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
		let httpErrorSettled = false;
		apiFetch("/api/projects").then(
			() => {
				httpErrorSettled = true;
			},
			() => {
				httpErrorSettled = true;
			}
		);

		await new Promise((r) => setTimeout(r, 0));
		expect(networkErrorSettled).toBe(false);
		expect(httpErrorSettled).toBe(false);

		Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
	});
});

// PROJ-430: an overnight 401 storm. The re-auth reload only helps if the reload
// actually reaches Cloudflare Access; when it doesn't, the reloaded page 401s
// again and reloads again, indefinitely. The guard below is what bounds that,
// independently of whether any given reload manages to re-authenticate.
describe("apiFetch — re-auth loop guard (PROJ-430)", () => {
	let reload: ReturnType<typeof vi.fn>;
	let originalLocation: Location;

	beforeEach(() => {
		sessionStorage.clear();
		__resetApiFetchStateForTests();
		reload = vi.fn();
		originalLocation = window.location;
		Object.defineProperty(window, "location", {
			configurable: true,
			value: { ...originalLocation, reload },
		});
	});

	const restoreLocation = () =>
		Object.defineProperty(window, "location", { configurable: true, value: originalLocation });

	it("does not reload a second time when the reloaded page 401s again", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

		apiFetch("/api/issues/i1");
		await new Promise((r) => setTimeout(r, 0));
		expect(reload).toHaveBeenCalledTimes(1);

		// Simulate the page actually reloading: module state resets, but the
		// sessionStorage marker survives the navigation.
		__resetApiFetchStateForTests();

		await expect(apiFetch("/api/issues/i1")).rejects.toBeInstanceOf(SessionExpiredError);
		expect(reload).toHaveBeenCalledTimes(1);

		restoreLocation();
	});

	// A page issues several requests at once. The first 401 triggers the reload; the rest
	// are the same expiry, not a second failed attempt, so they must stay silent until the
	// navigation happens. Otherwise whichever one lands second paints "your session has
	// expired" over the page for the instant before it goes away — and which request that
	// is depends on effect ordering, so it moves whenever the page's fetches are
	// rearranged (PROJ-438 moved it onto the issue page).
	it("stays silent for concurrent 401s while the first one's reload is in flight", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

		const first = apiFetch("/auth/me");
		await new Promise((r) => setTimeout(r, 0));
		expect(reload).toHaveBeenCalledTimes(1);

		let settled = false;
		const second = apiFetch("/api/issues/i1").then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			}
		);
		await new Promise((r) => setTimeout(r, 0));

		expect(settled).toBe(false);
		expect(reload).toHaveBeenCalledTimes(1);
		void first;
		void second;

		restoreLocation();
	});

	it("re-arms after a successful response, so a later expiry can re-auth again", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
		apiFetch("/api/issues/i1");
		await new Promise((r) => setTimeout(r, 0));
		expect(reload).toHaveBeenCalledTimes(1);

		// Reload succeeded: fresh module state, and a request now works.
		__resetApiFetchStateForTests();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "i1" }) })
		);
		await expect(apiFetch("/api/issues/i1")).resolves.toEqual({ id: "i1" });

		// A later session expiry is allowed to reload again.
		__resetApiFetchStateForTests();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
		apiFetch("/api/issues/i1");
		await new Promise((r) => setTimeout(r, 0));
		expect(reload).toHaveBeenCalledTimes(2);

		restoreLocation();
	});

	it("still reloads on a 401 when sessionStorage is unavailable", async () => {
		const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("storage disabled");
		});
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("storage disabled");
		});
		__resetApiFetchStateForTests();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));

		apiFetch("/api/issues/i1");
		await new Promise((r) => setTimeout(r, 0));
		expect(reload).toHaveBeenCalledTimes(1);

		getItem.mockRestore();
		setItem.mockRestore();
		restoreLocation();
	});
});

// PROJ-443: concurrent identical GETs share one underlying fetch. Not a cache — the
// dedupe entry only exists while the request is in flight.
describe("apiFetch — in-flight GET dedupe (PROJ-443)", () => {
	beforeEach(() => {
		sessionStorage.clear();
		__resetApiFetchStateForTests();
	});

	it("shares one fetch across concurrent GETs to the same path+slug", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "i1" }) });
		vi.stubGlobal("fetch", fetchMock);

		const [a, b] = await Promise.all([
			apiFetch("/api/issues/i1", { workspaceSlug: "ws1" }),
			apiFetch("/api/issues/i1", { workspaceSlug: "ws1" }),
		]);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(a).toEqual({ id: "i1" });
		expect(b).toEqual({ id: "i1" });
	});

	it("does not share fetches across different paths or different workspace slugs", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "i1" }) });
		vi.stubGlobal("fetch", fetchMock);

		await Promise.all([
			apiFetch("/api/issues/i1", { workspaceSlug: "ws1" }),
			apiFetch("/api/issues/i2", { workspaceSlug: "ws1" }),
			apiFetch("/api/issues/i1", { workspaceSlug: "ws2" }),
		]);

		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not share fetches across different on401 behaviours", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "i1" }) });
		vi.stubGlobal("fetch", fetchMock);

		await Promise.all([apiFetch("/auth/me", { on401: "throw" }), apiFetch("/auth/me")]);

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("never dedupes a GET with custom headers", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "i1" }) });
		vi.stubGlobal("fetch", fetchMock);

		await Promise.all([
			apiFetch("/api/issues/i1", { headers: { "X-Custom": "a" } }),
			apiFetch("/api/issues/i1", { headers: { "X-Custom": "b" } }),
		]);

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("never dedupes a POST", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "i1" }) });
		vi.stubGlobal("fetch", fetchMock);

		await Promise.all([
			apiFetch("/api/issues", { method: "POST", body: { title: "a" } }),
			apiFetch("/api/issues", { method: "POST", body: { title: "a" } }),
		]);

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("fetches again for a later identical GET once the first has settled", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "i1" }) });
		vi.stubGlobal("fetch", fetchMock);

		await apiFetch("/api/issues/i1", { workspaceSlug: "ws1" });
		await apiFetch("/api/issues/i1", { workspaceSlug: "ws1" });

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("rejects every joiner and clears the entry when the fetch rejects", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
		vi.stubGlobal("fetch", fetchMock);

		const first = apiFetch("/api/issues/i1", { workspaceSlug: "ws1" });
		const second = apiFetch("/api/issues/i1", { workspaceSlug: "ws1" });

		await expect(first).rejects.toBeInstanceOf(ApiOfflineError);
		await expect(second).rejects.toBeInstanceOf(ApiOfflineError);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ id: "i1" }) })
		);
		await expect(apiFetch("/api/issues/i1", { workspaceSlug: "ws1" })).resolves.toEqual({
			id: "i1",
		});
	});
});
