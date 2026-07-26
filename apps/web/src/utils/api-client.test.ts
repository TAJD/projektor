import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetApiFetchStateForTests,
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
