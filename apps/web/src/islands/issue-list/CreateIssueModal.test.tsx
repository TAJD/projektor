// PROJ-566 / CD-294: the Description caption must not *wrap* the markdown editor.
// A <label> with no `for` binds to its first labelable descendant, which inside
// MarkdownEditor is the toolbar's Bold button — so every click in the editor body
// was forwarded to Bold and wrapped subsequent typing in `**`.
import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { useEffect, useState } from "preact/hooks";
import { describe, expect, it } from "vitest";
import type { Issue, TaskStatus } from "../board-utils";
import CreateIssueModal, { defaultStatusLabel } from "./CreateIssueModal";
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

// WCAG 2.4.3 / 2.1.2: opening moves focus into the form, Tab can't leave it, and
// closing returns focus to the button that opened it.
function TriggerHarness() {
	const [, setIssues] = useState<Issue[]>([]);
	const modal = useCreateIssueModal({
		filterProject: "",
		projects: PROJECTS,
		statuses: [],
		taskTypes: [],
		setIssues,
	});
	return (
		<>
			<button type="button" onClick={modal.openCreateModal}>
				New issue
			</button>
			{modal.showCreateModal && (
				<CreateIssueModal {...modal} projects={PROJECTS} taskTypes={[]} statuses={[]} />
			)}
		</>
	);
}

describe("CreateIssueModal — focus management", () => {
	it("focuses the title on open and returns focus to the trigger on Escape", async () => {
		render(<TriggerHarness />);
		const trigger = screen.getByRole("button", { name: "New issue" });
		trigger.focus();
		fireEvent.click(trigger);
		const dialog = await screen.findByRole("dialog", { name: "Create new issue" });
		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByPlaceholderText("Issue title"))
		);

		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(dialog.isConnected).toBe(false));
		expect(document.activeElement).toBe(trigger);
	});

	it("wraps Tab from the last control back to the first", async () => {
		render(<TriggerHarness />);
		fireEvent.click(screen.getByRole("button", { name: "New issue" }));
		const dialog = await screen.findByRole("dialog", { name: "Create new issue" });
		const cancel = screen.getByRole("button", { name: "Cancel" });
		cancel.focus();
		fireEvent.keyDown(document, { key: "Tab" });
		expect(dialog.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).not.toBe(cancel);
	});
});

describe("defaultStatusLabel", () => {
	it("names the workspace's default status", () => {
		expect(
			defaultStatusLabel([
				{ id: "a", key: "todo", name: "Todo", category: "todo", color: null, is_default: 0 },
				{ id: "b", key: "backlog", name: "Backlog", category: "todo", color: null, is_default: 1 },
			])
		).toBe("Default (Backlog)");
	});
	it("falls back to plain 'Default' when none is flagged", () => {
		expect(defaultStatusLabel([])).toBe("Default");
	});
});
