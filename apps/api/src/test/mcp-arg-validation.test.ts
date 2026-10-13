import { env, SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateToolArgs } from "../mcp/validate-args";
import { authHeaders, seedFixture, toolError } from "./helpers";

// PROJ-920: MCP arguments are validated against each tool's inputSchema (types, enums,
// lengths, required) before the handler runs, so a wrongly-typed argument is a validation
// tool error naming the field — never a handler crash surfacing as an internal error.

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
	return res.json() as Promise<{
		result?: { tools: Array<{ name: string; inputSchema: Schema }> };
	}>;
}

describe("PROJ-920: MCP tool arguments are type-checked before the handler runs", () => {
	const prevMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000"; // one call per tool below
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevMax;
	});

	it("every tool rejects a wrongly-typed required argument with a validation tool error naming it", async () => {
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
			const err = toolError(res);
			if (err?.code !== "validation" || !err.fields || !(target in err.fields)) {
				failures.push(`${tool.name}.${target}: ${err?.code ?? "ok"} ${err?.message ?? ""}`);
			}
		}
		expect(checked).toBeGreaterThan(50);
		expect(failures).toEqual([]);
	}, 120_000);

	it("puts the failing field in fields like a service ValidationError", async () => {
		const f = await seedFixture({ role: "owner" });
		const headers = authHeaders(f.token, f.workspace.slug);
		const res = await rpc(f.workspace.id, headers, "tools/call", {
			name: "get_issue",
			arguments: { id: 42 },
		});
		const err = toolError(res);
		expect(err?.code).toBe("validation");
		expect(err?.fields?.id?.[0]).toMatch(/must be string/);
	});

	it("still reports missing required arguments by name (PROJ-877)", async () => {
		const f = await seedFixture({ role: "owner" });
		const headers = authHeaders(f.token, f.workspace.slug);
		const res = await rpc(f.workspace.id, headers, "tools/call", {
			name: "create_issue",
			arguments: {},
		});
		const err = toolError(res);
		expect(err?.code).toBe("validation");
		expect(err?.message).toContain("Missing required argument(s)");
		expect(err?.fields).toBeDefined();
		expect(Object.keys(err?.fields ?? {})).toContain("title");
	});
});

describe("PROJ-1007: every argument problem is reported in one pass", () => {
	const prevMax = env.RATE_LIMIT_API_MAX;
	beforeAll(() => {
		env.RATE_LIMIT_API_MAX = "10000";
	});
	afterAll(() => {
		env.RATE_LIMIT_API_MAX = prevMax;
	});

	async function callTool(name: string, args: Record<string, unknown>) {
		const f = await seedFixture({ role: "owner" });
		const headers = authHeaders(f.token, f.workspace.slug);
		return toolError(await rpc(f.workspace.id, headers, "tools/call", { name, arguments: args }));
	}

	it("reports an unknown key with a did-you-mean together with an invalid enum, and no hint", async () => {
		const err = await callTool("update_issue", { id: "PROJ-1", priorty: "high", status: "doing" });
		expect(err?.code).toBe("validation");
		expect(err?.fields?.priorty).toEqual(['Unknown argument "priorty"; did you mean "priority"?']);
		expect(err?.fields?.status?.[0]).toMatch(/must be one of/);
		expect(err?.hint).toBeUndefined();
	});

	it("catches a length Zod enforces in the first pass, alongside an unknown key", async () => {
		const err = await callTool("create_issue", { projectId: "PROJ", title: "", priorty: "high" });
		expect(err?.code).toBe("validation");
		expect(Object.keys(err?.fields ?? {}).sort()).toEqual(["priorty", "title"]);
	});

	it("prints the allowed values once when several array items are invalid", async () => {
		const err = await callTool("get_issue", { id: "PROJ-1", fields: ["foo", "bar"] });
		expect(err?.code).toBe("validation");
		expect(err?.fields?.fields).toHaveLength(1);
		expect(JSON.stringify(err).match(/workspace_id/g)).toHaveLength(1);
	});

	it("ignores a __proto__ key rather than taking arguments from it", async () => {
		const err = await callTool("get_project", JSON.parse('{"__proto__":{"id":"PROJ"}}'));
		expect(err?.code).toBe("validation");
		expect(err?.message).toBe("Missing required argument(s): id");
	});

	it("every tool reports an unknown key, with a did-you-mean, before its handler runs", async () => {
		const f = await seedFixture({ role: "owner" });
		const headers = authHeaders(f.token, f.workspace.slug);
		const tools = (await rpc(f.workspace.id, headers, "tools/list", {})).result?.tools ?? [];
		expect(tools.length).toBeGreaterThan(50);

		const failures: string[] = [];
		for (const tool of tools) {
			const props = (tool.inputSchema.properties ?? {}) as Record<string, Schema>;
			const required = ((tool.inputSchema.required ?? []) as string[]).filter((k) => props[k]);
			const args: Record<string, unknown> = {};
			for (const k of required) args[k] = validValue(props[k]);
			const first = Object.keys(props)[0];
			const typo = first ? `${first}x` : "bogusArg";
			args[typo] = "x";
			const expected = first
				? `Unknown argument "${typo}"; did you mean "${first}"?`
				: `Unknown argument "${typo}"`;

			const err = toolError(
				await rpc(f.workspace.id, headers, "tools/call", { name: tool.name, arguments: args })
			);
			if (err?.fields?.[typo]?.[0] !== expected) {
				failures.push(
					`${tool.name}: ${err?.code ?? "ok"} ${JSON.stringify(err?.fields ?? err?.message)}`
				);
			}
		}
		expect(failures).toEqual([]);
	}, 120_000);
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

	it("accepts valid args and null for nullable fields", () => {
		expect(
			validateToolArgs(schema, {
				status: "todo",
				assigneeId: null,
				labels: ["a"],
				limit: 3,
			})
		).toEqual([]);
	});

	it("reports undeclared keys, suggesting a declared property within edit distance 2", () => {
		expect(validateToolArgs(schema, { status: "todo", lables: ["a"] })).toEqual([
			{ path: "lables", message: 'Unknown argument "lables"; did you mean "labels"?' },
		]);
		expect(validateToolArgs(schema, { status: "todo", Limit: 2 })).toEqual([
			{ path: "Limit", message: 'Unknown argument "Limit"; did you mean "limit"?' },
		]);
		expect(validateToolArgs(schema, { status: "todo", extra: 1 })).toEqual([
			{ path: "extra", message: 'Unknown argument "extra"' },
		]);
	});

	it("reports undeclared keys inside nested objects at their full path", () => {
		const nested: Schema = {
			type: "object",
			properties: { report: { type: "object", properties: { prLink: { type: "string" } } } },
		};
		expect(validateToolArgs(nested, { report: { prLnk: "x" } })).toEqual([
			{ path: "report.prLnk", message: 'Unknown argument "prLnk"; did you mean "prLink"?' },
		]);
	});

	it("leaves objects open that allow additionalProperties or declare no properties", () => {
		expect(
			validateToolArgs(
				{ type: "object", properties: { a: { type: "string" } }, additionalProperties: true },
				{ b: 1 }
			)
		).toEqual([]);
		expect(
			validateToolArgs(
				{ type: "object", properties: { values: { type: "object" } } },
				{ values: { anything: 1 } }
			)
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
