import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	type JsonRpcError,
	type JsonRpcResult,
	seedIssue,
	seedIssueFixture,
} from "./helpers";

describe("compose_playbook", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let projectId: string;
	let userId: string;
	let epicId: string;
	let epicNumber: number;

	beforeEach(async () => {
		const fixture = await seedIssueFixture({ issueTitle: "Ship the widget" });
		token = fixture.token;
		slug = fixture.slug;
		workspaceId = fixture.workspaceId;
		projectId = fixture.projectId;
		userId = fixture.userId;
		epicId = fixture.issueId;
		// Read the seeded number directly from D1 rather than via the API — hitting
		// GET /api/issues/:id here would warm getIssue's cache before children are
		// seeded below, and compose_playbook's own getIssue call would then read a
		// stale (childless) rollup for the rest of the test.
		const row = await env.DB.prepare("SELECT number FROM issues WHERE id = ?")
			.bind(epicId)
			.first<{ number: number }>();
		epicNumber = row!.number;
	});

	async function compose(params: Record<string, unknown>) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "compose_playbook", arguments: { name: "epic-goal", params } },
			}),
		});
		return res;
	}

	it("composes with defaults (bounded, opus, cadence 2) and embeds live data", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "Child 1", parentId: epicId });
		await seedIssue(workspaceId, projectId, userId, {
			title: "Child 2 (done)",
			status: "done",
			parentId: epicId,
		});

		const res = await compose({ epicRef: `PROJ-${epicNumber}` });
		const json = (await res.json()) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const body = JSON.parse(json.result.content[0].text) as {
			name: string;
			variant: string;
			directive: string;
		};

		expect(body.name).toBe("epic-goal");
		expect(body.variant).toBe("bounded");
		expect(body.directive).toContain("Ship the widget");
		expect(body.directive).toContain(`PROJ-${epicNumber}`);
		expect(body.directive).toContain("Self-feed (bounded)");
		expect(body.directive).not.toContain("Self-feed (full)");
		expect(body.directive).toContain("every 2 completed tickets");
		expect(body.directive).toContain("adversarial opus review");
		// one open child (Child 1), one done (Child 2) -> rollup.remaining == 1
		expect(body.directive).toContain("1 open child ticket(s)");
		expect(body.directive).toContain("WIP limit is 3");
	});

	it("composes the full variant with a custom review model and cadence", async () => {
		const res = await compose({
			epicRef: `PROJ-${epicNumber}`,
			variant: "full",
			reviewModel: "sonnet",
			cadence: 5,
		});
		const json = (await res.json()) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const body = JSON.parse(json.result.content[0].text) as { variant: string; directive: string };

		expect(body.variant).toBe("full");
		expect(body.directive).toContain("Self-feed (full)");
		expect(body.directive).not.toContain("Self-feed (bounded)");
		expect(body.directive).toContain("every 5 completed tickets");
		expect(body.directive).toContain("adversarial sonnet review");
	});

	it("notes when the epic has no open child tickets yet", async () => {
		const res = await compose({ epicRef: `PROJ-${epicNumber}` });
		const json = (await res.json()) as JsonRpcResult<{ content: Array<{ text: string }> }>;
		const body = JSON.parse(json.result.content[0].text) as { directive: string };

		expect(body.directive).toContain("no open child tickets yet");
	});

	it("errors on an unresolvable epicRef", async () => {
		const res = await compose({ epicRef: "PROJ-999999" });
		const json = (await res.json()) as JsonRpcError;
		expect(json.error.code).toBe(-32000);
		expect(json.error.message).toContain("not found");
	});

	it("errors on a missing epicRef", async () => {
		const res = await compose({});
		const json = (await res.json()) as JsonRpcError;
		expect(json.error.code).toBe(-32602);
	});

	it("errors on an invalid cadence", async () => {
		const res = await compose({ epicRef: `PROJ-${epicNumber}`, cadence: -1 });
		const json = (await res.json()) as JsonRpcError;
		expect(json.error.code).toBe(-32602);
	});

	it("errors on an unknown playbook name, naming valid options", async () => {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "compose_playbook",
					arguments: { name: "does-not-exist", params: { epicRef: `PROJ-${epicNumber}` } },
				},
			}),
		});
		const json = (await res.json()) as {
			error: { message: string; data?: { validNames: string[] } };
		};
		expect(json.error.message).toContain("does-not-exist");
		expect(json.error.data?.validNames).toContain("epic-goal");
	});
});
