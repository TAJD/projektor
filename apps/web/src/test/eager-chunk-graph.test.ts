import { describe, expect, it } from "vitest";
import {
	buildImportGraph,
	closure,
	eagerRootsForPage,
	findOffendingChunks,
} from "../../scripts/eager-chunk-graph.mjs";

// PROJ-868: unit coverage for the pure graph logic behind
// apps/web/scripts/assert-eager-chunks.mjs, independent of a real dist/ build.

describe("eager-chunk-graph", () => {
	describe("buildImportGraph / closure", () => {
		it("follows only static imports, not dynamic import()", () => {
			const contents = new Map([
				["entry.js", 'import{a}from"./shared.js";import("./lazy.js");'],
				["shared.js", "export const a=1;"],
				["lazy.js", "export const b=2;"],
			]);
			const graph = buildImportGraph(contents);
			const reached = closure(["entry.js"], graph);
			expect(reached).toEqual(new Set(["entry.js", "shared.js"]));
			expect(reached.has("lazy.js")).toBe(false);
		});

		it('handles the bare `import"./x.js"` side-effect form', () => {
			const contents = new Map([
				["entry.js", 'import"./side-effect.js";'],
				["side-effect.js", 'console.log("loaded");'],
			]);
			const graph = buildImportGraph(contents);
			expect(closure(["entry.js"], graph)).toEqual(new Set(["entry.js", "side-effect.js"]));
		});

		it("does not loop forever on a dependency cycle", () => {
			const contents = new Map([
				["a.js", 'import"./b.js";'],
				["b.js", 'import"./a.js";'],
			]);
			const graph = buildImportGraph(contents);
			expect(closure(["a.js"], graph)).toEqual(new Set(["a.js", "b.js"]));
		});
	});

	describe("eagerRootsForPage", () => {
		it('collects client="load" and client="idle" islands, but not client="visible"', () => {
			const html = `
        <astro-island component-url="/_astro/Eager.abc.js" renderer-url="/_astro/client.xyz.js" client="load"></astro-island>
        <astro-island component-url="/_astro/AlsoEager.def.js" client="idle"></astro-island>
        <astro-island component-url="/_astro/Lazy.ghi.js" client="visible"></astro-island>
      `;
			const roots = eagerRootsForPage(html);
			expect(roots).toEqual(new Set(["Eager.abc.js", "client.xyz.js", "AlsoEager.def.js"]));
		});

		it('also collects directly-loaded <script type="module"> tags', () => {
			const html = `<script type="module" src="/_astro/Router.abc.js"></script>`;
			expect(eagerRootsForPage(html)).toEqual(new Set(["Router.abc.js"]));
		});
	});

	describe("findOffendingChunks", () => {
		it("flags a real chunk reachable from both the eager and mermaid graphs", () => {
			const eagerSet = new Set(["signals.js", "src.abcd.js"]);
			const mermaidSet = new Set(["mermaid.core.js", "src.abcd.js"]);
			expect(findOffendingChunks(eagerSet, mermaidSet)).toEqual(["src.abcd.js"]);
		});

		it("does not flag generic shared bundler-runtime shims", () => {
			const eagerSet = new Set([
				"signals.js",
				"rolldown-runtime.wxyz.js",
				"preload-helper.wxyz.js",
			]);
			const mermaidSet = new Set([
				"mermaid.core.js",
				"rolldown-runtime.wxyz.js",
				"preload-helper.wxyz.js",
			]);
			expect(findOffendingChunks(eagerSet, mermaidSet)).toEqual([]);
		});

		it("does not flag the pre-existing marked/markdown overlap", () => {
			const eagerSet = new Set(["markdown.wxyz.js"]);
			const mermaidSet = new Set(["mermaid.core.js", "markdown.wxyz.js"]);
			expect(findOffendingChunks(eagerSet, mermaidSet)).toEqual([]);
		});

		it("reports nothing when the two graphs do not overlap", () => {
			expect(findOffendingChunks(new Set(["a.js"]), new Set(["b.js"]))).toEqual([]);
		});
	});
});
