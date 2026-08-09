import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeaders, type JsonRpcError, type JsonRpcResult, seedIssueFixture } from "./helpers";

describe("MCP prompts", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let epicId: string;
	let epicNumber: number;

	beforeEach(async () => {
		const fixture = await seedIssueFixture({ issueTitle: "Ship the widget" });
		token = fixture.token;
		slug = fixture.slug;
		workspaceId = fixture.workspaceId;
		epicId = fixture.issueId;
		// Read the seeded number directly from D1, same reasoning as
		// playbook-compose.test.ts: avoid warming getIssue's KV cache via REST.
		const row = await env.DB.prepare("SELECT number FROM issues WHERE id = ?")
			.bind(epicId)
			.first<{ number: number }>();
		epicNumber = row!.number;
	});

	async function mcpCall(method: string, params: unknown) {
		const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
			method: "POST",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
		});
		return res.json();
	}

	it("prompts/list returns the epic-goal prompt with its arguments", async () => {
		const json = (await mcpCall("prompts/list", {})) as JsonRpcResult<{
			prompts: Array<{
				name: string;
				description: string;
				arguments: Array<{ name: string; required: boolean }>;
			}>;
		}>;
		const prompt = json.result.prompts.find((p) => p.name === "epic-goal");
		expect(prompt).toBeDefined();
		const argNames = prompt!.arguments.map((a) => a.name);
		expect(argNames).toEqual(["epicRef", "variant", "reviewModel", "cadence"]);
		expect(prompt!.arguments.find((a) => a.name === "epicRef")?.required).toBe(true);
		expect(prompt!.arguments.find((a) => a.name === "variant")?.required).toBe(false);
	});

	it("prompts/get with only epicRef returns the composed directive as a user message", async () => {
		const json = (await mcpCall("prompts/get", {
			name: "epic-goal",
			arguments: { epicRef: `PROJ-${epicNumber}` },
		})) as JsonRpcResult<{
			description: string;
			messages: Array<{ role: string; content: { type: string; text: string } }>;
		}>;
		expect(json.result.messages).toHaveLength(1);
		expect(json.result.messages[0].role).toBe("user");
		expect(json.result.messages[0].content.type).toBe("text");
		expect(json.result.messages[0].content.text).toContain("Ship the widget");
		expect(json.result.messages[0].content.text).toContain("Self-feed (bounded)");
	});

	it("prompts/get honors string-valued variant/reviewModel/cadence arguments", async () => {
		const json = (await mcpCall("prompts/get", {
			name: "epic-goal",
			arguments: {
				epicRef: `PROJ-${epicNumber}`,
				variant: "full",
				reviewModel: "sonnet",
				cadence: "5",
			},
		})) as JsonRpcResult<{ messages: Array<{ content: { text: string } }> }>;
		const text = json.result.messages[0].content.text;
		expect(text).toContain("Self-feed (full)");
		expect(text).toContain("every 5 completed tickets");
		expect(text).toContain("adversarial sonnet review");
	});

	it("prompts/get on an unresolvable epicRef surfaces the compose error", async () => {
		const json = (await mcpCall("prompts/get", {
			name: "epic-goal",
			arguments: { epicRef: "PROJ-999999" },
		})) as JsonRpcError;
		expect(json.error.code).toBe(-32000);
		expect(json.error.message).toContain("not found");
	});

	it("prompts/get on an unknown prompt name errors, naming valid options", async () => {
		const json = (await mcpCall("prompts/get", {
			name: "does-not-exist",
			arguments: {},
		})) as JsonRpcError;
		expect(json.error.message).toContain("does-not-exist");
		expect((json.error.data as { validNames: string[] })?.validNames).toContain("epic-goal");
	});
});
