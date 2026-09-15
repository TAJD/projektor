import { beforeEach, describe, expect, it } from "vitest";
import { applyPrefsToDocument, readPrefs, writePrefs } from "./prefs";

beforeEach(() => {
	localStorage.clear();
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-density");
	document.documentElement.removeAttribute("data-sidebar");
});

describe("readPrefs", () => {
	it("defaults to system theme, comfortable density and an expanded sidebar", () => {
		expect(readPrefs()).toEqual({ theme: "system", density: "comfortable", sidebar: "expanded" });
	});

	it("migrates the legacy standalone 'theme' key when no prefs object exists yet", () => {
		localStorage.setItem("theme", "dark");
		expect(readPrefs()).toEqual({ theme: "dark", density: "comfortable", sidebar: "expanded" });
	});

	it("ignores a malformed legacy theme value", () => {
		localStorage.setItem("theme", "purple");
		expect(readPrefs()).toEqual({ theme: "system", density: "comfortable", sidebar: "expanded" });
	});

	it("reads a stored prefs object once one exists", () => {
		localStorage.setItem(
			"prefs",
			JSON.stringify({ theme: "light", density: "compact", sidebar: "collapsed" })
		);
		expect(readPrefs()).toEqual({ theme: "light", density: "compact", sidebar: "collapsed" });
	});

	it("falls back field-by-field on a malformed stored prefs object", () => {
		localStorage.setItem("prefs", JSON.stringify({ theme: "neon", density: "compact" }));
		expect(readPrefs()).toEqual({ theme: "system", density: "compact", sidebar: "expanded" });
	});

	it("degrades to defaults when localStorage throws", () => {
		const original = window.localStorage;
		Object.defineProperty(window, "localStorage", {
			configurable: true,
			get() {
				throw new Error("blocked");
			},
		});
		try {
			expect(readPrefs()).toEqual({ theme: "system", density: "comfortable", sidebar: "expanded" });
		} finally {
			Object.defineProperty(window, "localStorage", { configurable: true, value: original });
		}
	});
});

describe("writePrefs", () => {
	it("stores the prefs object and clears the legacy key", () => {
		localStorage.setItem("theme", "dark");
		writePrefs({ theme: "light", density: "compact", sidebar: "collapsed" });
		expect(JSON.parse(localStorage.getItem("prefs") ?? "{}")).toEqual({
			theme: "light",
			density: "compact",
			sidebar: "collapsed",
		});
		expect(localStorage.getItem("theme")).toBeNull();
	});
});

describe("applyPrefsToDocument", () => {
	it("sets data-density and data-sidebar, and removes data-theme for 'system'", () => {
		applyPrefsToDocument({ theme: "system", density: "compact", sidebar: "collapsed" });
		expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
		expect(document.documentElement.getAttribute("data-density")).toBe("compact");
		expect(document.documentElement.getAttribute("data-sidebar")).toBe("collapsed");
	});

	it("sets data-theme for an explicit light/dark choice", () => {
		applyPrefsToDocument({ theme: "dark", density: "comfortable", sidebar: "expanded" });
		expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
	});
});
