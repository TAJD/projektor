import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBrand, applyBrandToDocument, type BrandConfig, getBrandName } from "./brand";

const DEFAULT_BRAND: BrandConfig = {
	name: "Projektor",
	mark: "P",
	accent: null,
	onAccent: null,
	logoUrl: null,
};

function setupHead() {
	document.head.innerHTML = `
		<title>Issues — Projektor</title>
		<meta name="description" content="Projektor — project management for humans and agents.">
		<meta property="og:title" content="Projektor">
		<meta property="og:description" content="Projektor — project management for humans and agents.">
		<meta name="apple-mobile-web-app-title" content="Projektor">
		<meta name="theme-color" content="#007a87" media="(prefers-color-scheme: light)">
		<meta name="theme-color" content="#1fbdcb" media="(prefers-color-scheme: dark)">
		<link rel="icon" type="image/svg+xml" href="/favicon.svg">
		<link rel="apple-touch-icon" href="/icon-192.png">
	`;
	document.body.innerHTML = `
		<a class="topbar-brand"><span class="brand-mark">P</span><span class="brand-name">Projektor</span></a>
	`;
}

beforeEach(() => {
	setupHead();
	document.documentElement.removeAttribute("style");
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("applyBrandToDocument", () => {
	it("leaves everything untouched for the Projektor defaults", () => {
		applyBrandToDocument(DEFAULT_BRAND);
		expect(document.title).toBe("Issues — Projektor");
		expect(document.querySelector(".brand-name")?.textContent).toBe("Projektor");
		expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/favicon.svg");
	});

	it("swaps the brand name in a suffixed page title, not just a bare one", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, name: "Acme" });
		expect(document.title).toBe("Issues — Acme");
	});

	it("swaps the brand name across title, meta tags and the topbar", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, name: "Acme" });
		expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
			"Acme — project management for humans and agents."
		);
		expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
			"Acme"
		);
		expect(
			document.querySelector('meta[name="apple-mobile-web-app-title"]')?.getAttribute("content")
		).toBe("Acme");
		expect(document.querySelector(".brand-name")?.textContent).toBe("Acme");
	});

	it("swaps the topbar mark when overridden", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, mark: "X" });
		expect(document.querySelector(".brand-mark")?.textContent).toBe("X");
	});

	it("renders an untrusted brand name as text, not markup", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, name: '<img src=x onerror="1">' });
		expect(document.querySelector(".brand-name")?.textContent).toBe('<img src=x onerror="1">');
		expect(document.querySelector("img")).toBeNull();
	});

	it("falls back to the default name and mark when the response is malformed", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, name: undefined as unknown as string });
		expect(document.title).toBe("Issues — Projektor");
	});

	it("points the favicon and apple-touch-icon at a custom logo, dropping any stale type", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, logoUrl: "/brand/logo.png" });
		const icon = document.querySelector('link[rel="icon"]');
		expect(icon?.getAttribute("href")).toBe("/brand/logo.png");
		expect(icon?.hasAttribute("type")).toBe(false);
		expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
			"/brand/logo.png"
		);
	});

	it("overrides the accent custom properties and both theme-color meta tags", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, accent: "#16a34a" });
		expect(document.documentElement.style.getPropertyValue("--light-accent")).toBe("#16a34a");
		expect(document.documentElement.style.getPropertyValue("--dark-accent")).toBe("#16a34a");
		for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
			expect(meta.getAttribute("content")).toBe("#16a34a");
		}
	});

	it("overrides the on-accent custom properties when set", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, onAccent: "#0d1117" });
		expect(document.documentElement.style.getPropertyValue("--light-on-accent")).toBe("#0d1117");
		expect(document.documentElement.style.getPropertyValue("--dark-on-accent")).toBe("#0d1117");
	});
});

describe("applyBrand and getBrandName caching", () => {
	beforeEach(() => {
		vi.resetModules();
	});

	it("fetches /api/config/brand once, applying and caching the result for later re-application", async () => {
		const {
			applyBrand: freshApplyBrand,
			applyCachedBrand,
			getBrandName: freshGetBrandName,
		} = await import("./brand");
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ ...DEFAULT_BRAND, name: "Acme" })));

		await freshApplyBrand(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(document.title).toBe("Issues — Acme");
		expect(freshGetBrandName()).toBe("Acme");

		setupHead();
		await freshApplyBrand(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(document.title).toBe("Issues — Acme");

		setupHead();
		applyCachedBrand();
		expect(document.title).toBe("Issues — Acme");
	});

	it("leaves the document untouched when the fetch fails", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));
		await applyBrand(fetchImpl);
		expect(document.title).toBe("Issues — Projektor");
	});

	it("leaves the document untouched on a non-ok response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
		await applyBrand(fetchImpl);
		expect(document.title).toBe("Issues — Projektor");
	});

	it("getBrandName returns the default before any brand has been fetched", () => {
		expect(getBrandName()).toBe("Projektor");
	});
});
