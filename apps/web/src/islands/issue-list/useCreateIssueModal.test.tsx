// PROJ-414: submitCreate must distinguish an offline (network) failure from a
// generic HTTP error, since CreateIssueModal shows whatever message createError holds.
import { fireEvent, render, screen } from "@testing-library/preact";
import { useEffect, useState } from "preact/hooks";
import { describe, expect, it, vi } from "vitest";
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
	// The real flow sets createProjectId via openCreateModal() when the "New issue"
	// button is clicked; this harness skips that button and opens the modal directly.
	useEffect(() => {
		modal.openCreateModal();
	}, []);
	return <CreateIssueModal {...modal} projects={PROJECTS} taskTypes={[]} statuses={[]} />;
}

describe("useCreateIssueModal — offline submit", () => {
	it("shows an offline-specific message when the create request fails due to network failure", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

		render(<Harness />);
		fireEvent.input(screen.getByPlaceholderText("Issue title"), {
			target: { value: "Fix the thing" },
		});
		fireEvent.click(screen.getByRole("button", { name: /create issue/i }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/you're offline/i);
	});

	it("shows a generic message for a non-offline (HTTP) failure", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));

		render(<Harness />);
		fireEvent.input(screen.getByPlaceholderText("Issue title"), {
			target: { value: "Fix the thing" },
		});
		fireEvent.click(screen.getByRole("button", { name: /create issue/i }));

		const alert = await screen.findByRole("alert");
		expect(alert.textContent).toMatch(/failed to create issue/i);
		expect(alert.textContent).not.toMatch(/you're offline/i);
	});
});
