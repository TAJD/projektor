import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveWorkspaceSlug } from "./workspace";

function stubHost(hostname: string) {
	vi.stubGlobal("location", { hostname } as Location);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("resolveWorkspaceSlug", () => {
	it("prefers an explicit build-time slug over the hostname", () => {
		stubHost("projektor.example.workers.dev");
		expect(resolveWorkspaceSlug("acme")).toBe("acme");
	});

	it("falls back to the hostname's first label when no slug is baked in", () => {
		stubHost("projektor.tajdickson.workers.dev");
		expect(resolveWorkspaceSlug(undefined)).toBe("projektor");
	});

	it("returns '' for hosts with no tenant subdomain", () => {
		for (const h of ["localhost", "127.0.0.1", "example"]) {
			stubHost(h);
			expect(resolveWorkspaceSlug(undefined)).toBe("");
		}
	});
});
