// PROJ-566 / CD-294: the Description caption must not *wrap* the markdown editor.
// A <label> with no `for` binds to its first labelable descendant, which inside
// MarkdownEditor is the toolbar's Bold button — so every click in the editor body
// was forwarded to Bold and wrapped subsequent typing in `**`.
import { render, screen } from "@testing-library/preact";
import { useEffect, useState } from "preact/hooks";
import { describe, expect, it } from "vitest";
import type { Issue, TaskStatus } from "../board-utils";
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

const TWO_PROJECTS = [...PROJECTS, { id: "p2", key: "OTHER", name: "Other", description: null }];
const TASK_TYPES = [{ id: "t1", key: "BUG", name: "Bug" }];
const STATUSES: TaskStatus[] = [
	{ id: "s1", key: "todo", name: "To do", category: "todo", color: null },
];

function FieldsHarness() {
	const [, setIssues] = useState<Issue[]>([]);
	const modal = useCreateIssueModal({
		filterProject: "",
		projects: TWO_PROJECTS,
		statuses: STATUSES,
		taskTypes: TASK_TYPES,
		setIssues,
	});
	useEffect(() => {
		modal.openCreateModal();
	}, []);
	return (
		<CreateIssueModal
			{...modal}
			projects={TWO_PROJECTS}
			taskTypes={TASK_TYPES}
			statuses={STATUSES}
		/>
	);
}

// PROJ-566 (same class, other fields): the Project/Priority/Type/Status captions
// wrapped their <Select>. A <label> with no `for` binds to its first labelable
// descendant — Select's trigger <button> — and forwards clicks from every
// non-interactive descendant to it, including the menu's own <li> options.
describe("CreateIssueModal — Select field captions (PROJ-566)", () => {
	for (const caption of ["Project", "Priority", "Type", "Status"]) {
		it(`renders the ${caption} label as a caption with no implicit control`, () => {
			render(<FieldsHarness />);
			const label = screen.getByText(caption, { selector: "label" }) as HTMLLabelElement;
			expect(label.control).toBeNull();
		});
	}

	it("leaves each Select named by its own ariaLabel", () => {
		render(<FieldsHarness />);
		for (const name of ["Select project", "Select priority", "Select type", "Select status"]) {
			expect(screen.getByRole("combobox", { name })).toBeTruthy();
		}
	});
});
