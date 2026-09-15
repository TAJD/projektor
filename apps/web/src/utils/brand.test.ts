import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyBrand, applyBrandToDocument, type BrandConfig } from "./brand";

const DEFAULT_BRAND: BrandConfig = {
	name: "Projektor",
	mark: "P",
	accent: null,
	onAccent: null,
	logoUrl: null,
};

function setupHead() {
	document.head.innerHTML = `
		<title>Projektor</title>
		<meta name="description" content="Projektor — project management for humans and agents.">
		<meta property="og:title" content="Projektor">
		<meta property="og:description" content="Projektor — project management for humans and agents.">
		<meta name="apple-mobile-web-app-title" content="Projektor">
		<meta name="theme-color" content="#4f46e5" media="(prefers-color-scheme: light)">
		<meta name="theme-color" content="#6366f1" media="(prefers-color-scheme: dark)">
		<link rel="icon" href="/favicon.svg">
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
		expect(document.title).toBe("Projektor");
		expect(document.querySelector(".brand-name")?.textContent).toBe("Projektor");
		expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/favicon.svg");
	});

	it("swaps the brand name across title, meta tags and the topbar", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, name: "Acme" });
		expect(document.title).toBe("Acme");
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

	it("points the favicon and apple-touch-icon at a custom logo", () => {
		applyBrandToDocument({ ...DEFAULT_BRAND, logoUrl: "/brand/logo.svg" });
		expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(
			"/brand/logo.svg"
		);
		expect(document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href")).toBe(
			"/brand/logo.svg"
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

describe("applyBrand", () => {
	it("fetches /api/config/brand and applies the result", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ ...DEFAULT_BRAND, name: "Acme" })));
		await applyBrand(fetchImpl);
		expect(fetchImpl).toHaveBeenCalledWith("/api/config/brand");
		expect(document.title).toBe("Acme");
	});

	it("leaves the document untouched when the fetch fails", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("network error"));
		await applyBrand(fetchImpl);
		expect(document.title).toBe("Projektor");
	});

	it("leaves the document untouched on a non-ok response", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response("", { status: 500 }));
		await applyBrand(fetchImpl);
		expect(document.title).toBe("Projektor");
	});
});
