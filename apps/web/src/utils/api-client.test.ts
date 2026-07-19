import { beforeEach, describe, expect, it, vi } from "vitest";
import { __resetApiFetchStateForTests, ApiOfflineError, apiFetch } from "./api-client";

describe("apiFetch", () => {
	beforeEach(() => {
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
