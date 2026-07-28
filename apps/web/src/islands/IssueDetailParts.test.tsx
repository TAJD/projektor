// IssueDetailParts island — BodySection overflow-containment regression test (PROJ-344).
//
// A wide markdown table or a long unbroken code line must not force the whole
// page to scroll horizontally on mobile; the rendered-markdown container must
// carry its own horizontal scroll instead. jsdom doesn't lay out real pixel
// widths, so this asserts the containing class rather than measured overflow.
import { render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BodySection } from "./IssueDetailParts";
import type { Comment, IssueData } from "./issue-detail-helpers";

const WIDE_TABLE_BODY = `
| Column A | Column B | Column C | Column D | Column E | Column F | Column G |
| --- | --- | --- | --- | --- | --- | --- |
| aaaaaaaaaa | bbbbbbbbbb | cccccccccc | dddddddddd | eeeeeeeeee | ffffffffff | gggggggggg |

\`\`\`
${"x".repeat(200)}
\`\`\`
`;

const ISSUE: IssueData = {
	id: "i1",
	number: 1,
	title: "Issue with wide content",
	body: WIDE_TABLE_BODY,
	priority: "medium",
	assignee_id: null,
	assignee_name: null,
	parent_id: null,
	project_key: "PROJ",
	project_name: "Projektor",
	type_key: null,
	type_name: null,
	status_id: null,
	status_key: null,
	status_name: null,
	status_category: null,
	created_at: 1000,
	updated_at: 1000,
	customFields: [],
};

describe("BodySection", () => {
	it("wraps the rendered markdown body in a horizontally-scrollable container", async () => {
		render(
			<BodySection
				issue={ISSUE}
				issueId={ISSUE.id}
				workspaceSlug="ws"
				fetchIssue={async () => {}}
			/>
		);

		const table = await screen.findByRole("table");
		const container = table.closest(".prose");
		expect(container).toBeTruthy();
		expect(container?.className).toContain("overflow-x-auto");
		expect(container?.className).toContain("break-words");

		// The long code line rendered inside <pre> — the wrapping container is
		// still the scroll boundary, not the page.
		const pre = container?.querySelector("pre");
		expect(pre).toBeTruthy();
		expect(pre?.closest(".prose")).toBe(container);
	});
});

// Mermaid hydration (PROJ-447) — mirrors markdown.test.ts's mocked-mermaid approach,
// but through the island so we assert the effect actually wires up renderMermaidDiagrams.
describe("BodySection — mermaid hydration", () => {
	afterEach(() => {
		vi.doUnmock("mermaid");
		vi.resetModules();
	});

	it("hydrates a mermaid fence in the issue body", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const initialize = vi.fn();
		vi.doMock("mermaid", () => ({ default: { initialize, run } }));
		vi.resetModules();
		const { BodySection: MockedBodySection } = await import("./IssueDetailParts");

		render(
			<MockedBodySection
				issue={{ ...ISSUE, body: "```mermaid\ngraph TD\n    A --> B\n```" }}
				issueId={ISSUE.id}
				workspaceSlug="ws"
				fetchIssue={async () => {}}
			/>
		);

		await waitFor(() => {
			expect(run).toHaveBeenCalled();
		});
	});

	it("does not hydrate (mermaid.run is never called) for a body without a fence", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const initialize = vi.fn();
		vi.doMock("mermaid", () => ({ default: { initialize, run } }));
		vi.resetModules();
		const { BodySection: MockedBodySection } = await import("./IssueDetailParts");

		render(
			<MockedBodySection
				issue={ISSUE}
				issueId={ISSUE.id}
				workspaceSlug="ws"
				fetchIssue={async () => {}}
			/>
		);

		await screen.findByRole("table");
		expect(run).not.toHaveBeenCalled();
	});
});

const COMMENT: Comment = {
	id: "c1",
	body: "```mermaid\ngraph TD\n    A --> B\n```",
	author_id: "u1",
	author_name: "Author",
	author_email: "author@example.com",
	created_at: 1000,
};

describe("CommentsSection — mermaid hydration", () => {
	afterEach(() => {
		vi.doUnmock("mermaid");
		vi.resetModules();
	});

	it("hydrates a mermaid fence in a comment body", async () => {
		const run = vi.fn().mockResolvedValue(undefined);
		const initialize = vi.fn();
		vi.doMock("mermaid", () => ({ default: { initialize, run } }));
		vi.resetModules();
		const { CommentsSection: MockedCommentsSection } = await import("./IssueDetailParts");

		render(
			<MockedCommentsSection
				issueId="i1"
				workspaceSlug="ws"
				comments={[COMMENT]}
				currentUserId={null}
				fetchComments={async () => {}}
			/>
		);

		await waitFor(() => {
			expect(run).toHaveBeenCalled();
		});
	});
});
