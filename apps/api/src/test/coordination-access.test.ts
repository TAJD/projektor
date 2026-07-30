import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedAgentLease,
	seedGroupGrant,
	seedIssue,
	seedProject,
	seedWorkspaceRoles,
} from "./helpers";

// PROJ-316: the fleet-coordination list surfaces (issue-leases, file-claims,
// agents) must respect the same default-deny project visibility as issues — a
// non-admin member with no grant on a project must not be able to enumerate its
// issue IDs, file paths, or agent activity. Owner/admin bypass groups.

type ListResult = { items: Array<Record<string, unknown>> };

async function mcpList(
	tool: string,
	token: string,
	slug: string,
	workspaceId: string
): Promise<ListResult> {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers: authHeaders(token, slug),
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: tool, arguments: {} },
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ text: string }> };
	};
	return JSON.parse(body.result.content[0].text) as ListResult;
}

async function seedFileClaim(workspaceId: string, issueId: string, path: string) {
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO issue_file_claims (id, workspace_id, issue_id, agent_id, path, claimed_at, released_at)
		 VALUES (?, ?, ?, NULL, ?, ?, NULL)`
	)
		.bind(crypto.randomUUID(), workspaceId, issueId, path, now)
		.run();
}

async function seedFloatingAgent(workspaceId: string, name: string): Promise<string> {
	const id = crypto.randomUUID();
	const now = Math.floor(Date.now() / 1000);
	await env.DB.prepare(
		`INSERT INTO agent_sessions
		   (id, workspace_id, issue_id, token_id, name, kind, status, started_at, last_heartbeat_at, ended_at)
		 VALUES (?, ?, NULL, NULL, ?, 'agent', 'active', ?, ?, NULL)`
	)
		.bind(id, workspaceId, name, now, now)
		.run();
	return id;
}

describe("PROJ-316 coordination data respects project visibility", () => {
	let ws: Awaited<ReturnType<typeof seedWorkspaceRoles>>;
	let slug: string;
	let issueA: string;
	let issueB: string;

	beforeEach(async () => {
		ws = await seedWorkspaceRoles();
		slug = ws.workspace.slug;
		const projectA = await seedProject(ws.workspace.id, "AAA");
		const projectB = await seedProject(ws.workspace.id, "BBB");
		// The member can see project A only.
		await seedGroupGrant(ws.workspace.id, ws.member.user.id, projectA.id, "member");

		issueA = (await seedIssue(ws.workspace.id, projectA.id, ws.owner.user.id, { title: "A" })).id;
		issueB = (await seedIssue(ws.workspace.id, projectB.id, ws.owner.user.id, { title: "B" })).id;

		// A live lease + agent on each issue, a file claim on each, and one agent
		// pinned to no issue (workspace-level coordination).
		await seedAgentLease(ws.workspace.id, issueA, { name: "agent-A" });
		await seedAgentLease(ws.workspace.id, issueB, { name: "agent-B" });
		await seedFileClaim(ws.workspace.id, issueA, "a/only.ts");
		await seedFileClaim(ws.workspace.id, issueB, "b/secret.ts");
		await seedFloatingAgent(ws.workspace.id, "floating");
	});

	it("owner sees leases/claims/agents across every project", async () => {
		const t = ws.owner.token;
		const leases = await mcpList("list_issue_leases", t, slug, ws.workspace.id);
		expect(leases.items.map((l) => l.issueId).sort()).toEqual([issueA, issueB].sort());

		const claims = await mcpList("list_file_claims", t, slug, ws.workspace.id);
		expect(claims.items.map((c) => c.path).sort()).toEqual(["a/only.ts", "b/secret.ts"]);

		const agents = await mcpList("list_active_agents", t, slug, ws.workspace.id);
		expect(agents.items.map((a) => a.name).sort()).toEqual(["agent-A", "agent-B", "floating"]);
	});

	it("a member sees only the granted project's leases and file claims", async () => {
		const t = ws.member.token;
		const leases = await mcpList("list_issue_leases", t, slug, ws.workspace.id);
		expect(leases.items.map((l) => l.issueId)).toEqual([issueA]);

		const claims = await mcpList("list_file_claims", t, slug, ws.workspace.id);
		expect(claims.items.map((c) => c.path)).toEqual(["a/only.ts"]);
	});

	it("a member sees agents on granted projects plus issue-less agents, never hidden-project agents", async () => {
		const agents = await mcpList("list_active_agents", ws.member.token, slug, ws.workspace.id);
		const names = agents.items.map((a) => a.name).sort();
		expect(names).toEqual(["agent-A", "floating"]);
		expect(names).not.toContain("agent-B");
	});

	it("a member with no grants at all sees none of another project's coordination data", async () => {
		const t = ws.viewer.token; // viewer has no group grant
		const leases = await mcpList("list_issue_leases", t, slug, ws.workspace.id);
		expect(leases.items).toHaveLength(0);
		const claims = await mcpList("list_file_claims", t, slug, ws.workspace.id);
		expect(claims.items).toHaveLength(0);
		const agents = await mcpList("list_active_agents", t, slug, ws.workspace.id);
		// only the issue-less floating agent leaks nothing about a hidden project
		expect(agents.items.map((a) => a.name)).toEqual(["floating"]);
	});
});
