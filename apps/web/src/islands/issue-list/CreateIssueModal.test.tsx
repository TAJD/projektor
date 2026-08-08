// PROJ-566 / CD-294: the Description caption must not *wrap* the markdown editor.
// A <label> with no `for` binds to its first labelable descendant, which inside
// MarkdownEditor is the toolbar's Bold button — so every click in the editor body
// was forwarded to Bold and wrapped subsequent typing in `**`.
import { render, screen } from "@testing-library/preact";
import { useEffect, useState } from "preact/hooks";
import { describe, expect, it } from "vitest";
import type { Issue } from "../board-utils";
import CreateIssueModal from "./CreateIssueModal";
import { useCreateIssueModal } from "./useCreateIssueModal";

const PROJECTS = [{ id: "p1", key: "PROJ", name: "Projektor", description: null }];

function Harness() {
	const [, setIssues] = useState<Issue[]>([]);
	const modal = useCreateIssueModal({
		filterProject: "",
		projects: PROJECTS,
		statuses: [],
		taskTypes: [],
		setIssues,
	});
	useEffect(() => {
		modal.openCreateModal();
	}, []);
	return <CreateIssueModal {...modal} projects={PROJECTS} taskTypes={[]} statuses={[]} />;
}

describe("CreateIssueModal — Description caption (PROJ-566)", () => {
	it("renders the Description label as a caption with no implicit control", () => {
		render(<Harness />);

		const caption = screen.getByText("Description");
		expect(caption.tagName).toBe("LABEL");
		// The assertion that fails on the old markup: a wrapping label captures the
		// editor's first labelable descendant (the Bold button, or the lazy fallback's
		// textarea before the chunk lands) as its implicit control.
		expect((caption as HTMLLabelElement).control).toBeNull();
	});

	it("gives the editor its own accessible name instead", async () => {
		render(<Harness />);
		expect(await screen.findByLabelText("Description")).toBeTruthy();
	});
});
