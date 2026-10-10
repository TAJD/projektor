import { SELF } from "cloudflare:test";
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

	it("a member with a grant on the project is unaffected", async () => {
		const reg = await call("register_agent", { name: "ok", issueId: visibleIssue });
		expect(toolError(reg)).toBeUndefined();
		const claim = await call("claim_files", { issueId: visibleIssue, paths: ["ok.ts"] });
		expect(toolError(claim)).toBeUndefined();
		const msg = await call("post_message", { scope: `issue:${visibleIssue}`, body: "hi" });
		expect(toolError(msg)).toBeUndefined();
	});
});
