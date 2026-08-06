// MarkdownEditor island — rendering tests.
//
// MarkdownEditor has no network dependency. It mounts a CodeMirror editor and
// renders a live preview pane. The pattern: render with props, assert on the
// toolbar buttons and preview pane content. cleanup runs via setup.ts afterEach.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MarkdownEditor, { PASTE_IMAGE_TYPES } from "./MarkdownEditor";

describe("MarkdownEditor", () => {
	it("renders the formatting toolbar with core buttons", () => {
		render(<MarkdownEditor value="" onChange={() => {}} />);
		expect(screen.getByTitle("Bold (Ctrl+B)")).toBeTruthy();
		expect(screen.getByTitle("Italic (Ctrl+I)")).toBeTruthy();
		expect(screen.getByTitle("Heading 1")).toBeTruthy();
		expect(screen.getByTitle("Heading 2")).toBeTruthy();
		expect(screen.getByTitle("Link")).toBeTruthy();
	});

	it("shows 'Nothing to preview.' when value is empty", () => {
		render(<MarkdownEditor value="" onChange={() => {}} />);
		expect(screen.getByText(/Nothing to preview/i)).toBeTruthy();
	});

	it("renders markdown content in the preview pane", async () => {
		render(<MarkdownEditor value="Hello World" onChange={() => {}} />);
		// CodeMirror shows the raw text; the preview pane shows the rendered version.
		// getAllByText handles both occurrences.
		await waitFor(() => {
			const matches = screen.getAllByText("Hello World");
			expect(matches.length).toBeGreaterThan(0);
		});
	});

	it("accepts and wires an onChange callback without throwing", () => {
		const onChange = vi.fn();
		// Verifies that the component mounts without error when onChange is provided.
		render(<MarkdownEditor value="initial content" onChange={onChange} />);
		expect(screen.getByTitle("Bold (Ctrl+B)")).toBeTruthy();
	});

	it("renders the mobile Edit / Preview toggle buttons", () => {
		render(<MarkdownEditor value="" onChange={() => {}} />);
		// The mobile toggle div is in the DOM regardless of viewport width in jsdom.
		// There are two buttons: 'Edit' and 'Preview'.
		const buttons = screen.getAllByRole("button");
		const labels = buttons.map((b) => b.textContent);
		expect(labels).toContain("Edit");
		// 'Preview' appears both as a toggle button and as a pane label.
		expect(labels.some((l) => l?.includes("Preview"))).toBe(true);
	});

	it("resets text-transform so it can't inherit an ancestor's uppercase (PROJ-210)", () => {
		// The create-issue Description sits inside a <label class="uppercase">, and
		// text-transform inherits — without this guard everything typed renders as
		// caps. The reset must live on the editor's own root so it holds wherever
		// the editor is mounted.
		const { container } = render(<MarkdownEditor value="" onChange={() => {}} />);
		const root = container.firstElementChild;
		expect(root?.className).toContain("normal-case");
	});

	it("resets font-weight so it can't inherit an ancestor's bold (PROJ-566)", () => {
		// The create-issue Description sits inside a <label class="font-semibold">, and
		// font-weight inherits — without this guard everything typed renders bold.
		// The reset must live on the editor's own root so it holds wherever the
		// editor is mounted.
		const { container } = render(<MarkdownEditor value="" onChange={() => {}} />);
		const root = container.firstElementChild;
		expect(root?.className).toContain("font-normal");
	});

	describe("debounced preview render (PROJ-227)", () => {
		beforeEach(() => {
			vi.useFakeTimers();
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		it("does not update the preview pane until the debounce elapses", async () => {
			const { rerender } = render(<MarkdownEditor value="" onChange={() => {}} />);
			expect(screen.getByText(/Nothing to preview/i)).toBeTruthy();

			rerender(<MarkdownEditor value="Fresh text" onChange={() => {}} />);

			// Preview state hasn't re-rendered yet — the empty-state message still shows.
			expect(screen.getByText(/Nothing to preview/i)).toBeTruthy();

			await vi.advanceTimersByTimeAsync(200);

			expect(screen.queryByText(/Nothing to preview/i)).toBeNull();
		});

		it("restarts the debounce timer on rapid successive edits instead of rendering each keystroke", async () => {
			const { rerender } = render(<MarkdownEditor value="" onChange={() => {}} />);

			rerender(<MarkdownEditor value="F" onChange={() => {}} />);
			await vi.advanceTimersByTimeAsync(150);
			rerender(<MarkdownEditor value="Fr" onChange={() => {}} />);
			await vi.advanceTimersByTimeAsync(150);
			rerender(<MarkdownEditor value="Fresh text" onChange={() => {}} />);

			// Each edit arrived within 200ms of the last, so no render has fired yet.
			expect(screen.getByText(/Nothing to preview/i)).toBeTruthy();

			await vi.advanceTimersByTimeAsync(200);

			expect(screen.queryByText(/Nothing to preview/i)).toBeNull();
		});
	});

	it("doesn't nest a second auto-overflow scroll container around CodeMirror's own scroller (PROJ-305)", () => {
		// CodeMirror's `.cm-scroller` already sets `overflow: auto` internally. Wrapping
		// it in a sibling container that ALSO has `overflow-auto` inside a stretched
		// flex row caused a real-browser layout thrash (content height change -> flex
		// re-stretch -> CM re-measures -> height changes again) that froze the page
		// mid-typing. jsdom has no layout engine so this can't be caught by behavior —
		// assert directly on the mount container's class instead.
		const { container } = render(<MarkdownEditor value="" onChange={() => {}} />);
		const editorPane = container.querySelector(".cm-editor")?.parentElement;
		expect(editorPane?.className).not.toContain("overflow-auto");
	});

	it("switches to preview pane when the mobile Preview button is clicked", () => {
		render(<MarkdownEditor value="" onChange={() => {}} />);
		const buttons = screen.getAllByRole("button");
		// The mobile Preview toggle is a button with text 'Preview'
		const previewToggle = buttons.find((b) => b.textContent === "Preview");
		expect(previewToggle).toBeDefined();
		if (!previewToggle) throw new Error("Preview toggle not found");
		fireEvent.click(previewToggle);
		// After click the Edit button loses its active styles (class contains bg-transparent)
		const editToggle = buttons.find((b) => b.textContent === "Edit");
		expect(editToggle?.className).toContain("border-border");
	});
});

// ─── PROJ-431: mobile editing ────────────────────────────────────────────────

describe("MarkdownEditor — mobile ergonomics (PROJ-431)", () => {
	const source = readFileSync(join(__dirname, "MarkdownEditor.tsx"), "utf-8");

	// Toolbar buttons were ~24px tall (py-[2px] at 0.8rem), well under the 44px
	// accessible touch target. Desktop keeps the original compact sizing.
	it("gives toolbar buttons a 44px touch target on small screens only", () => {
		expect(source).toMatch(/min-w-\[44px\] min-h-\[44px\] sm:min-w-0 sm:min-h-0/);
	});

	it("gives the mobile Edit/Preview toggle a 44px touch target", () => {
		expect(source).toMatch(/min-h-\[44px\][^"]*px-\[14px\]/);
	});

	// Below 16px, iOS Safari zooms the viewport when the field takes focus, and the
	// viewport meta sets no maximum-scale.
	it("sets a 16px editor font on phones and restores 0.875rem from 640px up", () => {
		expect(source).toMatch(/fontSize:\s*"1rem"/);
		expect(source).toMatch(
			/"@media \(min-width: 640px\)":\s*\{\s*"\.cm-content":\s*\{\s*fontSize:\s*"0\.875rem"\s*\}/
		);
	});
});

// ─── PROJ-494: paste/drag-drop image upload ────────────────────────────────

function findCmContent(container: Element): HTMLElement {
	const el = container.querySelector(".cm-content");
	if (!el) throw new Error("cm-content not found");
	return el as HTMLElement;
}

describe("MarkdownEditor — inline image paste/drop (PROJ-494)", () => {
	it("mirrors the backend's INLINE_TYPES (SVG excluded)", () => {
		expect([...PASTE_IMAGE_TYPES].sort()).toEqual([
			"image/gif",
			"image/jpeg",
			"image/png",
			"image/webp",
		]);
	});

	it("uploads a pasted image via onImageFile and inserts markdown at the cursor", async () => {
		const onChange = vi.fn();
		const onImageFile = vi.fn().mockResolvedValue("/api/files/abc123");
		const { container } = render(
			<MarkdownEditor value="" onChange={onChange} onImageFile={onImageFile} />
		);
		const file = new File(["fake"], "screenshot.png", { type: "image/png" });
		const clipboardData = {
			items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
			files: [file],
			getData: () => "",
		};
		fireEvent.paste(findCmContent(container), { clipboardData });

		await waitFor(() => expect(onImageFile).toHaveBeenCalledWith(file));
		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith(
				expect.stringContaining("![screenshot.png](/api/files/abc123)")
			)
		);
	});

	it("ignores a pasted file whose type isn't an inline-renderable image", async () => {
		const onImageFile = vi.fn();
		const { container } = render(
			<MarkdownEditor value="" onChange={() => {}} onImageFile={onImageFile} />
		);
		const file = new File(["data"], "doc.pdf", { type: "application/pdf" });
		const clipboardData = {
			items: [{ kind: "file", type: "application/pdf", getAsFile: () => file }],
			files: [file],
			getData: () => "",
		};
		fireEvent.paste(findCmContent(container), { clipboardData });

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(onImageFile).not.toHaveBeenCalled();
	});

	it("does not intercept paste when onImageFile is not provided", () => {
		const { container } = render(<MarkdownEditor value="" onChange={() => {}} />);
		const file = new File(["fake"], "a.png", { type: "image/png" });
		const clipboardData = {
			items: [{ kind: "file", type: "image/png", getAsFile: () => file }],
			files: [file],
			getData: () => "",
		};
		expect(() => fireEvent.paste(findCmContent(container), { clipboardData })).not.toThrow();
	});

	it("uploads a dropped image via onImageFile and inserts markdown", async () => {
		const onChange = vi.fn();
		const onImageFile = vi.fn().mockResolvedValue("/api/files/xyz789");
		const { container } = render(
			<MarkdownEditor value="" onChange={onChange} onImageFile={onImageFile} />
		);
		const file = new File(["fake"], "drop.gif", { type: "image/gif" });
		const dataTransfer = { files: [file], items: [], getData: () => "" };
		fireEvent.drop(findCmContent(container), { dataTransfer, clientX: 0, clientY: 0 });

		await waitFor(() => expect(onImageFile).toHaveBeenCalledWith(file));
		await waitFor(() =>
			expect(onChange).toHaveBeenCalledWith(
				expect.stringContaining("![drop.gif](/api/files/xyz789)")
			)
		);
	});

	it("ignores a dropped file whose type isn't an inline-renderable image", async () => {
		const onImageFile = vi.fn();
		const { container } = render(
			<MarkdownEditor value="" onChange={() => {}} onImageFile={onImageFile} />
		);
		const file = new File(["data"], "doc.zip", { type: "application/zip" });
		const dataTransfer = { files: [file], items: [], getData: () => "" };
		fireEvent.drop(findCmContent(container), { dataTransfer, clientX: 0, clientY: 0 });

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(onImageFile).not.toHaveBeenCalled();
	});
});
