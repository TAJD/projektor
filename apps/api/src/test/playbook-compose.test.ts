import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	type JsonRpcError,
	type JsonRpcResult,
	seedIssue,
	seedIssueFixture,
	seedProject,
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

	it("composes with defaults (bounded, opus, cadence 2), well-formed blockquote, and embeds live data", async () => {
		await seedIssue(workspaceId, projectId, userId, { title: "Child 1", parentId: epicId });
		await seedIssue(workspaceId, projectId, userId, {
			title: "Child 2 (done)",
			status: "done",
			parentId: epicId,
		});
		// Non-default WIP limit so the assertion below can't pass on the fallback
		// default (DEFAULT_AGENT_WIP_LIMIT is also 3) — prove the value actually
		// flows from the project row, not from fetchAgentWipCap's no-match default.
		await env.DB.prepare("UPDATE projects SET agent_wip_limit = ? WHERE id = ?")
			.bind(7, projectId)
			.run();

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
		expect(body.directive).toContain("WIP limit is 7");
		// every quoted line starts with "> " and there's no run-on "clause>clause"
		// artifact from a malformed line-join
		for (const line of body.directive.split("\n")) {
			expect(line === ">" || line.startsWith("> ")).toBe(true);
		}
		expect(body.directive).not.toMatch(/[^\n]>\s*$/m);
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

	it("errors like an unresolvable ref when epicRef points at a project the caller can't see", async () => {
		// A second project in the same workspace that the fixture's member token
		// was never granted access to (seedIssueFixture only grants the first
		// project) — assertIssueProjectVisible must reject this before any
		// title/rollup data is returned.
		const otherProject = await seedProject(workspaceId, "SECRET");
		const otherEpic = await seedIssue(workspaceId, otherProject.id, userId, {
			title: "Confidential epic",
		});

		const res = await compose({ epicRef: `SECRET-${otherEpic.number}` });
		const json = (await res.json()) as JsonRpcError;
		expect(json.error.code).toBe(-32000);
		expect(json.error.message).toContain("not found");
		expect(json.error.message).not.toContain("Confidential epic");
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

// PROJ-633: REST parity for compose_playbook
describe("POST /api/playbooks/:name/compose", () => {
	let token: string;
	let slug: string;
	let epicNumber: number;

	beforeEach(async () => {
		const fixture = await seedIssueFixture({ issueTitle: "Ship the widget" });
		token = fixture.token;
		slug = fixture.slug;
		const row = await env.DB.prepare("SELECT number FROM issues WHERE id = ?")
			.bind(fixture.issueId)
			.first<{ number: number }>();
		epicNumber = row!.number;
	});

	it("returns 200 for epic-goal with a valid params body", async () => {
		const res = await SELF.fetch("http://localhost/api/playbooks/epic-goal/compose", {
			method: "POST",
			headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
			body: JSON.stringify({ epicRef: `PROJ-${epicNumber}` }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { name: string; variant: string; directive: string };
		expect(body.name).toBe("epic-goal");
		expect(body.directive).toContain("Ship the widget");
	});

	it("returns a 4xx via the service's validation for a bad body", async () => {
		const res = await SELF.fetch("http://localhost/api/playbooks/epic-goal/compose", {
			method: "POST",
			headers: { ...authHeaders(token, slug), "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		// Specifically 400, not a 4xx range: an unregistered route would 404 and satisfy
		// a range assertion, so the loose form cannot tell "validation rejected this"
		// from "this endpoint does not exist".
		expect(res.status).toBe(400);
	});
});
