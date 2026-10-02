// IssueDetailParts island — BodySection overflow-containment regression test (PROJ-344),
// updated for PROJ-603.
//
// A wide markdown table or a long unbroken code line must not force the whole
// page to scroll horizontally on mobile. PROJ-344 originally made the whole
// `.prose` box a horizontal scrollport (`overflow-x-auto`) to contain them —
// but per the CSS overflow spec, setting overflow-x to a non-visible value
// while overflow-y stays visible forces overflow-y to `auto` too, turning the
// entire box into a scrollport that clips anything an ordered/unordered list
// marker renders outside its gutter (PROJ-603). The fix moves the scroll
// boundary onto the individual elements that actually need it: <pre> already
// gets `overflow-x: auto` from Typography by default, and each rendered
// <table> is wrapped in a `.table-scroll` div that gets the same via
// MERMAID_PROSE_STYLES (PROJ-605: the wrapper carries the scroll boundary
// instead of `display: block` on <table> itself, so a narrow table still
// renders full-width instead of shrinking to content). jsdom doesn't lay out
// real pixel widths, so this asserts the containing classes/rules rather than
// measured overflow.
import { render, screen, waitFor } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentsSection, BodySection, RelationsSection } from "./IssueDetailParts";
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
	type_id: null,
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
	it("does not turn the .prose box itself into a scrollport (PROJ-603)", async () => {
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
		// PROJ-603: overflow-x-auto here forces overflow-y to auto too (CSS
		// overflow spec), clipping outside-positioned list markers. The scroll
		// boundary now lives on <pre>/<table> themselves, not this container.
		expect(container?.className).not.toContain("overflow-x-auto");
		expect(container?.className).toContain("break-words");

		// The long code line rendered inside <pre>, which still self-scrolls
		// (Typography's default `pre { overflow-x: auto }`).
		const pre = container?.querySelector("pre");
		expect(pre).toBeTruthy();
		expect(pre?.closest(".prose")).toBe(container);
	});

	it("wraps wide tables in .table-scroll for their own scroll boundary (PROJ-603, PROJ-605)", async () => {
		render(
			<BodySection
				issue={ISSUE}
				issueId={ISSUE.id}
				workspaceSlug="ws"
				fetchIssue={async () => {}}
			/>
		);

		const table = await screen.findByRole("table");
		// renderMd's table renderer (markdown.ts) wraps every rendered <table> in
		// this div — the scroll boundary lives on the wrapper, not the table.
		expect(table.parentElement?.className).toBe("table-scroll");

		const styleTags = Array.from(document.querySelectorAll("style"));
		const tableRule = styleTags
			.map((s) => s.textContent)
			.find((css) => css?.includes(".prose .table-scroll"));
		expect(tableRule).toBeTruthy();
		expect(tableRule).toContain("overflow-x: auto");
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

// PROJ-876: DELETE /api/files/:id answers 204; apiFetch used to throw on the empty body,
// the catch swallowed it, and the deleted attachment stayed listed until a reload.
describe("AttachmentsSection delete (PROJ-876)", () => {
	afterEach(() => vi.unstubAllGlobals());

	const attachment = {
		id: "att-1",
		kind: "file" as const,
		filename: "notes.txt",
		contentType: "text/plain",
		size: 10,
		url: null,
		createdAt: 0,
		wikiPage: null,
	};

	it("refreshes the list after a 204 delete", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 204 })));
		const fetchAttachments = vi.fn().mockResolvedValue(undefined);
		render(
			<AttachmentsSection
				issueId="i1"
				workspaceSlug="ws"
				attachments={[attachment]}
				fetchAttachments={fetchAttachments}
			/>
		);
		screen.getByLabelText(/Remove notes\.txt/).click();
		await waitFor(() => expect(fetchAttachments).toHaveBeenCalled());
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("shows an error when the delete fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 403 }));
		const fetchAttachments = vi.fn().mockResolvedValue(undefined);
		render(
			<AttachmentsSection
				issueId="i1"
				workspaceSlug="ws"
				attachments={[attachment]}
				fetchAttachments={fetchAttachments}
			/>
		);
		screen.getByLabelText(/Remove notes\.txt/).click();
		await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/Couldn't delete/));
		expect(fetchAttachments).not.toHaveBeenCalled();
	});
});

// PROJ-961: a done issue that spawned a follow-up reads "Partially done → PROJ-n".
describe("RelationsSection follow-ups (PROJ-961)", () => {
	const followedBy = {
		id: "l1",
		type: "followed_by" as const,
		linkedIssueId: "i2",
		linkedIssueTitle: "Follow-up: Issue",
		linkedIssueNumber: 7,
		linkedIssueProjectKey: "PROJ",
		linkedIssueStatusCategory: "todo",
		createdById: "u1",
		createdAt: 0,
	};

	function renderWith(category: string | null, links = [followedBy]) {
		render(
			<RelationsSection
				issueId="i1"
				workspaceSlug="ws"
				links={links}
				fetchingLinks={false}
				fetchLinks={vi.fn().mockResolvedValue(undefined)}
				issueStatusCategory={category}
			/>
		);
	}

	it("labels the follow-up 'Partially done →' on a done issue", () => {
		renderWith("done");
		expect(screen.getByText("Partially done →")).toBeTruthy();
		expect(screen.getByText("PROJ-7")).toBeTruthy();
	});

	it("labels it 'Followed by' while the issue is still open", () => {
		renderWith("in_progress");
		expect(screen.getByText("Followed by")).toBeTruthy();
		expect(screen.queryByText("Partially done →")).toBeNull();
	});

	it("shows 'Follows from' on the follow-up itself", () => {
		renderWith("todo", [{ ...followedBy, type: "follows_from" as never }]);
		expect(screen.getByText("Follows from")).toBeTruthy();
	});
});
