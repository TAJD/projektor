import { describe, expect, it, vi } from "vitest";
import { ApiOfflineError, apiFetch } from "./api-client";

describe("apiFetch", () => {
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
});
