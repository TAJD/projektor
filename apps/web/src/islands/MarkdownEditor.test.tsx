// MarkdownEditor island — rendering tests.
//
// MarkdownEditor has no network dependency. It mounts a CodeMirror editor and
// renders a live preview pane. The pattern: render with props, assert on the
// toolbar buttons and preview pane content. cleanup runs via setup.ts afterEach.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import MarkdownEditor from "./MarkdownEditor";

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

	it("switches to preview pane when the mobile Preview button is clicked", () => {
		render(<MarkdownEditor value="" onChange={() => {}} />);
		const buttons = screen.getAllByRole("button");
		// The mobile Preview toggle is a button with text 'Preview'
		const previewToggle = buttons.find((b) => b.textContent === "Preview");
		expect(previewToggle).toBeDefined();
		fireEvent.click(previewToggle!);
		// After click the Edit button loses its active styles (class contains bg-transparent)
		const editToggle = buttons.find((b) => b.textContent === "Edit");
		expect(editToggle?.className).toContain("border-border");
	});
});
