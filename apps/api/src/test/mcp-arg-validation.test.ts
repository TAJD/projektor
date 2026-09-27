import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateToolArgs } from "../mcp/validate-args";
import { authHeaders, type JsonRpcError, seedFixture } from "./helpers";

// PROJ-920: MCP arguments are validated against each tool's inputSchema (types, enums,
// lengths, required) before the handler runs, so a wrongly-typed argument is a -32602
// naming the field — never a handler crash surfacing as -32000.

type Schema = Record<string, unknown>;

function schemaType(s: Schema): string | undefined {
	return Array.isArray(s.type) ? (s.type[0] as string) : (s.type as string | undefined);
}

function validValue(s: Schema): unknown {
	if (Array.isArray(s.enum) && s.enum.length > 0) return s.enum[0];
	switch (schemaType(s)) {
		case "string":
			return "x".repeat(Math.max(1, typeof s.minLength === "number" ? s.minLength : 1));
		case "number":
		case "integer":
			return typeof s.minimum === "number" ? s.minimum : 1;
		case "boolean":
			return true;
		case "array":
			return [];
		case "object":
			return {};
		default:
			return "x";
	}
}

function wrongValue(s: Schema): unknown {
	switch (schemaType(s)) {
		case "string":
			return 42;
		case "number":
		case "integer":
			return "ten";
		case "boolean":
			return "yes";
		case "array":
		case "object":
			return "not-a-container";
		default:
			return undefined;
	}
}

async function rpc(
	workspaceId: string,
	headers: Record<string, string>,
	method: string,
	params: unknown
) {
	const res = await SELF.fetch(`http://localhost/mcp/${workspaceId}`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
	});
	return res.json() as Promise<
		{ result?: { tools: Array<{ name: string; inputSchema: Schema }> } } & Partial<JsonRpcError>
	>;
}

describe("PROJ-920: MCP tool arguments are type-checked before the handler runs", () => {
	const prevMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000"; // one call per tool below
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevMax;
	});

	it("every tool rejects a wrongly-typed required argument with -32602 naming it", async () => {
		const f = await seedFixture({ role: "owner" });
		const headers = authHeaders(f.token, f.workspace.slug);
		const list = await rpc(f.workspace.id, headers, "tools/list", {});
		const tools = list.result?.tools ?? [];
		expect(tools.length).toBeGreaterThan(50);

		const failures: string[] = [];
		let checked = 0;
		for (const tool of tools) {
			const props = (tool.inputSchema.properties ?? {}) as Record<string, Schema>;
			const required = ((tool.inputSchema.required ?? []) as string[]).filter((k) => props[k]);
			const target = required.find((k) => wrongValue(props[k]) !== undefined);
			if (!target) continue;
			const args: Record<string, unknown> = {};
			for (const k of required) args[k] = validValue(props[k]);
			args[target] = wrongValue(props[target]);

			const res = await rpc(f.workspace.id, headers, "tools/call", {
				name: tool.name,
				arguments: args,
			});
			checked++;
			if (res.error?.code !== -32602 || !res.error.message.includes(target)) {
				failures.push(
					`${tool.name}.${target}: ${res.error?.code ?? "ok"} ${res.error?.message ?? ""}`
				);
			}
		}
		expect(checked).toBeGreaterThan(50);
		expect(failures).toEqual([]);
	});

	it("puts the failing field in error.data like a service ValidationError", async () => {
		const f = await seedFixture({ role: "owner" });
		const headers = authHeaders(f.token, f.workspace.slug);
		const res = await rpc(f.workspace.id, headers, "tools/call", {
			name: "get_issue",
			arguments: { id: 42 },
		});
		expect(res.error?.code).toBe(-32602);
		const data = res.error?.data as { fieldErrors: Record<string, string[]> };
		expect(data.fieldErrors.id?.[0]).toMatch(/must be string/);
	});

	it("still reports missing required arguments by name (PROJ-877)", async () => {
		const f = await seedFixture({ role: "owner" });
		const headers = authHeaders(f.token, f.workspace.slug);
		const res = await rpc(f.workspace.id, headers, "tools/call", {
			name: "create_issue",
			arguments: {},
		});
		expect(res.error?.code).toBe(-32602);
		expect(res.error?.message).toContain("Missing required argument(s)");
	});
});

describe("validateToolArgs", () => {
	const schema: Schema = {
		type: "object",
		properties: {
			status: { type: "string", enum: ["todo", "done"] },
			assigneeId: { type: "string", nullable: true },
			labels: { type: "array", items: { type: "string" }, maxItems: 2 },
			limit: { type: "integer", minimum: 1 },
			title: { type: "string", minLength: 1, maxLength: 5 },
		},
		required: ["status"],
	};

	it("accepts valid args, null for nullable fields, and undeclared extras", () => {
		expect(
			validateToolArgs(schema, {
				status: "todo",
				assigneeId: null,
				labels: ["a"],
				limit: 3,
				extra: 1,
			})
		).toEqual([]);
	});

	it("reports enum, item, length, integer and minimum violations with paths", () => {
		const issues = validateToolArgs(schema, {
			status: "nope",
			labels: ["a", 2, "c"],
			limit: 1.5,
			title: "toolong",
		});
		const paths = issues.map((i) => i.path).sort();
		expect(paths).toEqual(["labels", "labels[1]", "limit", "status", "title"]);
	});

	it("stays as lenient as the services: numeric/boolean strings and null for optional fields", () => {
		expect(
			validateToolArgs(schema, { status: "done", limit: "3", labels: null, title: null })
		).toEqual([]);
		expect(
			validateToolArgs({ properties: { flag: { type: "boolean" } } }, { flag: "true" })
		).toEqual([]);
		expect(validateToolArgs(schema, { status: null }).map((i) => i.path)).toEqual(["status"]);
		expect(validateToolArgs(schema, { status: "todo", limit: "ten" }).map((i) => i.path)).toEqual([
			"limit",
		]);
	});
});
