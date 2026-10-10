import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	authHeaders,
	seedGroupGrant,
	seedIssue,
	seedProject,
	seedWorkspaceRoles,
	toolError,
} from "./helpers";

describe("PROJ-976 coordination tools respect project visibility for UUIDs", () => {
	let ws: Awaited<ReturnType<typeof seedWorkspaceRoles>>;
	let hiddenIssue: string;
	let visibleIssue: string;

	beforeEach(async () => {
		ws = await seedWorkspaceRoles();
		const visible = await seedProject(ws.workspace.id, "VIS");
		const hidden = await seedProject(ws.workspace.id, "HID");
		await seedGroupGrant(ws.workspace.id, ws.member.user.id, visible.id, "member");
		visibleIssue = (await seedIssue(ws.workspace.id, visible.id, ws.owner.user.id)).id;
		hiddenIssue = (await seedIssue(ws.workspace.id, hidden.id, ws.owner.user.id)).id;
	});

	async function call(tool: string, args: Record<string, unknown>, token = ws.member.token) {
		const res = await SELF.fetch(`http://localhost/mcp/${ws.workspace.id}`, {
			method: "POST",
			headers: authHeaders(token, ws.workspace.slug),
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: tool, arguments: args },
			}),
		});
		return (await res.json()) as {
			result: { isError?: boolean; content: Array<{ text: string }> };
		};
	}

	const payload = (tool: string, issueId: string, agentId: string) => {
		switch (tool) {
			case "claim_issue":
				return { issueId, agentId };
			case "claim_files":
				return { issueId, paths: ["x/y.ts"] };
			case "register_agent":
				return { name: "probe", issueId };
			default:
				return { scope: `issue:${issueId}`, body: "hello" };
		}
	};

	for (const tool of ["claim_issue", "claim_files", "register_agent", "post_message"]) {
		it(`${tool}: a hidden issue UUID answers like an unknown one`, async () => {
			const agentId = crypto.randomUUID();
			const hidden = toolError(await call(tool, payload(tool, hiddenIssue, agentId)));
			const unknown = toolError(await call(tool, payload(tool, crypto.randomUUID(), agentId)));
			expect(hidden).toBeDefined();
			expect(hidden?.code).toBe("not_found");
			expect(hidden?.message).toBe(unknown?.message);
		});
	}

	it("list_messages: a hidden issue's channel reads as empty for a member", async () => {
		const posted = await call(
			"post_message",
			{ scope: `issue:${hiddenIssue}`, body: "secret" },
			ws.owner.token
		);
		expect(toolError(posted)).toBeUndefined();

		const asMember = await call("list_messages", { scope: `issue:${hiddenIssue}` });
		expect(JSON.parse(asMember.result.content[0].text).items).toHaveLength(0);
		const asOwner = await call("list_messages", { scope: `issue:${hiddenIssue}` }, ws.owner.token);
		expect(JSON.parse(asOwner.result.content[0].text).items).toHaveLength(1);
	});

	async function seedHiddenHolder() {
		const agentId = crypto.randomUUID();
		const now = Math.floor(Date.now() / 1000);
		await env.DB.prepare(
			`INSERT INTO agent_sessions
			   (id, workspace_id, issue_id, token_id, name, kind, status, started_at, last_heartbeat_at, ended_at)
			 VALUES (?, ?, ?, NULL, 'hidden-holder', 'agent', 'active', ?, ?, NULL)`
		)
			.bind(agentId, ws.workspace.id, hiddenIssue, now, now)
			.run();
		await env.DB.prepare(
			`INSERT INTO issue_file_claims (id, workspace_id, issue_id, agent_id, path, claimed_at, released_at)
			 VALUES (?, ?, ?, ?, 'held/by-hidden.ts', ?, NULL)`
		)
			.bind(crypto.randomUUID(), ws.workspace.id, hiddenIssue, agentId, now)
			.run();
		return agentId;
	}

	const activeClaims = async () =>
		(
			await env.DB.prepare(
				"SELECT COUNT(*) AS n FROM issue_file_claims WHERE workspace_id = ? AND path = 'held/by-hidden.ts' AND released_at IS NULL"
			)
				.bind(ws.workspace.id)
				.first<{ n: number }>()
		)?.n;

	it("release_files without issueId leaves a hidden project's claims alone", async () => {
		await seedHiddenHolder();
		const res = await call("release_files", { paths: ["held/by-hidden.ts"] });
		expect(toolError(res)).toBeUndefined();
		expect(JSON.parse(res.result.content[0].text).count).toBe(0);
		expect(await activeClaims()).toBe(1);
	});

	it("claim_files conflict and force do not disclose or override a hidden holder", async () => {
		const agentId = await seedHiddenHolder();
		for (const force of [false, true]) {
			const err = toolError(
				await call("claim_files", { issueId: visibleIssue, paths: ["held/by-hidden.ts"], force })
			);
			expect(err?.code).toBe("conflict");
			expect(err?.message).not.toContain(hiddenIssue);
			expect(err?.message).not.toContain(agentId);
		}
		expect(await activeClaims()).toBe(1);
	});

	it("end_agent and heartbeat_agent treat a hidden project's session as not found", async () => {
		const agentId = await seedHiddenHolder();
		for (const tool of ["end_agent", "heartbeat_agent"]) {
			expect(toolError(await call(tool, { id: agentId }))?.code).toBe("not_found");
		}
		expect(await activeClaims()).toBe(1);
		const asOwner = await call("end_agent", { id: agentId }, ws.owner.token);
		expect(toolError(asOwner)).toBeUndefined();
		expect(await activeClaims()).toBe(0);
	});

	it("release_issue and list_issues parentId answer a hidden issue like an unknown one", async () => {
		const unknownId = crypto.randomUUID();
		const hiddenRelease = toolError(await call("release_issue", { issueId: hiddenIssue }));
		const unknownRelease = toolError(await call("release_issue", { issueId: unknownId }));
		expect(hiddenRelease?.code).toBe("not_found");
		expect(hiddenRelease?.message).toBe(unknownRelease?.message);

		const hiddenList = toolError(await call("list_issues", { parentId: hiddenIssue }));
		const unknownList = toolError(await call("list_issues", { parentId: unknownId }));
		expect(hiddenList?.code).toBe("not_found");
		expect(hiddenList?.message).toBe(unknownList?.message);
	});

	it("parent_ref is null when the parent sits in a project the member cannot see", async () => {
		await env.DB.prepare("UPDATE issues SET parent_id = ? WHERE id = ?")
			.bind(hiddenIssue, visibleIssue)
			.run();
		const res = await call("list_issues", { projectId: "VIS" });
		const items = JSON.parse(res.result.content[0].text).items as Array<{
			id: string;
			parent_ref?: string | null;
		}>;
		expect(items.find((i) => i.id === visibleIssue)?.parent_ref ?? null).toBeNull();
		const asOwner = await call("list_issues", { projectId: "VIS" }, ws.owner.token);
		const ownerItems = JSON.parse(asOwner.result.content[0].text).items as Array<{
			id: string;
			parent_ref?: string | null;
		}>;
		expect(ownerItems.find((i) => i.id === visibleIssue)?.parent_ref).toMatch(/^HID-\d+$/);
	});

	it("a member with a grant on the project is unaffected", async () => {
		const reg = await call("register_agent", { name: "ok", issueId: visibleIssue });
		expect(toolError(reg)).toBeUndefined();
		const claim = await call("claim_files", { issueId: visibleIssue, paths: ["ok.ts"] });
		expect(toolError(claim)).toBeUndefined();
		const msg = await call("post_message", { scope: `issue:${visibleIssue}`, body: "hi" });
		expect(toolError(msg)).toBeUndefined();
	});
});
