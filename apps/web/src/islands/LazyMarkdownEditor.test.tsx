import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import LazyMarkdownEditor from "./LazyMarkdownEditor";

afterEach(cleanup);

// PROJ-431: MarkdownEditor pulls in CodeMirror — 168 KiB gzip, 76% of the JS on
// /issues/view and /wiki — but only renders after the user taps Edit.
describe("LazyMarkdownEditor (PROJ-431)", () => {
	it("does not import MarkdownEditor statically at any call site", () => {
		for (const f of [
			"IssueDetailParts.tsx",
			"WikiPage.tsx",
			join("issue-list", "CreateIssueModal.tsx"),
		]) {
			const source = readFileSync(join(__dirname, f), "utf-8");
			expect(source, `${f} must not statically import MarkdownEditor`).not.toMatch(
				/from\s+"\.\.?\/MarkdownEditor"/
			);
			expect(source).toMatch(/from\s+"\.\.?\/LazyMarkdownEditor"/);
		}
	});

	it("loads the real editor through a dynamic import", () => {
		const source = readFileSync(join(__dirname, "LazyMarkdownEditor.tsx"), "utf-8");
		expect(source).toMatch(/import\("\.\/MarkdownEditor"\)/);
	});

	// Importing preact/compat anywhere in an island's graph switches Preact to React's
	// event semantics for that whole island. Using compat's lazy/Suspense here broke
	// native <select> onChange in IssueList, via CreateIssueModal.
	it("does not pull preact/compat into the editor call sites", () => {
		const source = readFileSync(join(__dirname, "LazyMarkdownEditor.tsx"), "utf-8");
		// An actual import, not the mention of it in the comment explaining why.
		expect(source).not.toMatch(/^import\s[^;]*"preact\/compat"/m);
	});

	// A spinner would mean staring at nothing for seconds on a phone. The fallback is a
	// working field on the same controlled contract, so typing starts immediately and the
	// text is already in `value` when CodeMirror mounts.
	it("renders a usable textarea while the editor chunk is in flight", async () => {
		const onChange = vi.fn();
		render(<LazyMarkdownEditor value="seed text" onChange={onChange} minHeight="240px" />);

		const field = await screen.findByLabelText("Markdown editor");
		expect((field as HTMLTextAreaElement).value).toBe("seed text");

		fireEvent.input(field, { target: { value: "typed while loading" } });
		await waitFor(() => expect(onChange).toHaveBeenCalledWith("typed while loading"));
	});

	// Below 16px iOS Safari zooms the viewport on focus, and the viewport meta sets no
	// maximum-scale — so the fallback must not be smaller than that on a phone.
	it("uses a 16px font on mobile so iOS does not zoom on focus", () => {
		const source = readFileSync(join(__dirname, "LazyMarkdownEditor.tsx"), "utf-8");
		expect(source).toMatch(/text-base sm:text-sm/);
	});

	// PROJ-566: the fallback's textarea inherits font-weight from a font-semibold field
	// caption the same way the real editor's CodeMirror content does — without this reset
	// it renders bold on a slow connection until the real editor mounts.
	it("resets font-weight on the fallback root so it can't inherit an ancestor's bold (PROJ-566)", () => {
		const { container } = render(<LazyMarkdownEditor value="" onChange={() => {}} />);
		const root = container.firstElementChild;
		expect(root?.className).toContain("font-normal");
	});
});
