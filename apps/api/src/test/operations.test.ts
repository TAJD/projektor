import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineOperation, operationsRouter, toMcpTool } from "../operations/define";
import { issueOperations } from "../operations/issues";
import { taskTypeOperations } from "../operations/task-types";
import {
	authHeaders,
	seedMember,
	seedProjectFixture,
	seedTaskStatus,
	seedTaskType,
	seedToken,
	seedUser,
} from "./helpers";

describe("PROJ-895: operations registry REST adapter", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId } = await seedProjectFixture({ role: "owner" }));
	});

	const post = (bearer: string, body: unknown) =>
		SELF.fetch("http://localhost/api/task-types", {
			method: "POST",
			headers: authHeaders(bearer, slug),
			body: JSON.stringify(body),
		});

	it("checks the workspace role before validating the input", async () => {
		const member = await seedUser("op-member@example.com");
		await seedMember(workspaceId, member.id, "member");
		const res = await post(await seedToken(workspaceId, member.id), { name: 5 });
		expect(res.status).toBe(403);
	});

	it("rejects a wrongly-typed field at the edge with the standard 400 shape", async () => {
		const res = await post(token, { key: "bug", name: 5 });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { details?: { fieldErrors?: Record<string, unknown> } };
		expect(JSON.stringify(body)).toContain("name");
	});

	it("takes the id from the path, not the body", async () => {
		const target = await seedTaskType(workspaceId, { key: "story", name: "Story" });
		const other = await seedTaskType(workspaceId, { key: "chore", name: "Chore" });
		const res = await SELF.fetch(`http://localhost/api/task-types/${target.id}`, {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ id: other.id, name: "Renamed" }),
		});
		expect(res.status).toBe(200);
		const list = (await (
			await SELF.fetch("http://localhost/api/task-types", { headers: authHeaders(token, slug) })
		).json()) as Array<{ id: string; name: string }>;
		expect(list.find((t) => t.id === target.id)?.name).toBe("Renamed");
		expect(list.find((t) => t.id === other.id)?.name).toBe("Chore");
	});

	it("gives nullable fields a type list the MCP arg validator enforces", () => {
		const update = taskTypeOperations.map(toMcpTool).find((t) => t.name === "update_task_type");
		const props = update?.inputSchema.properties as Record<string, Record<string, unknown>>;
		expect(props.color).toEqual({ type: ["string", "null"], maxLength: 50 });
		expect(props.position).toEqual({ type: "integer", minimum: 0 });
	});

	it("does not clear the workspace default when the task type does not exist", async () => {
		const current = await seedTaskType(workspaceId, { key: "task", name: "Task", isDefault: true });
		const res = await SELF.fetch("http://localhost/api/task-types/does-not-exist", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ isDefault: true }),
		});
		expect(res.status).toBe(404);
		const list = (await (
			await SELF.fetch("http://localhost/api/task-types", { headers: authHeaders(token, slug) })
		).json()) as Array<{ id: string; is_default?: number; isDefault?: number | boolean }>;
		const row = list.find((t) => t.id === current.id);
		expect(row?.is_default ?? row?.isDefault).toBeTruthy();
	});

	it("does not clear the default task status when the status does not exist", async () => {
		const current = await seedTaskStatus(workspaceId, {
			key: "open",
			name: "Open",
			category: "todo",
			isDefault: true,
		});
		const res = await SELF.fetch("http://localhost/api/task-statuses/does-not-exist", {
			method: "PATCH",
			headers: authHeaders(token, slug),
			body: JSON.stringify({ isDefault: true }),
		});
		expect(res.status).toBe(404);
		const list = (await (
			await SELF.fetch("http://localhost/api/task-statuses", { headers: authHeaders(token, slug) })
		).json()) as Array<{ id: string; is_default?: number; isDefault?: number | boolean }>;
		const row = list.find((s) => s.id === current.id);
		expect(row?.is_default ?? row?.isDefault).toBeTruthy();
	});

	it("refuses to mount an operation outside the router's base path", () => {
		expect(() => operationsRouter("/api/projects", taskTypeOperations)).toThrow(/outside/);
	});

	it("treats an MCP null as absent unless the field accepts null", async () => {
		const tool = toMcpTool(
			defineOperation({
				id: "probe",
				method: "GET",
				path: "/api/probe",
				domain: "probe",
				tier: "read",
				summary: "probe",
				keywords: [],
				input: z.object({
					limit: z.number().default(10),
					label: z.string().nullable().optional(),
				}),
				run: async (_ctx, input) => input,
			})
		);
		const ctx = { role: "owner" } as never;
		expect(await tool.handler({ limit: null, label: null }, ctx)).toEqual({
			limit: 10,
			label: null,
		});
	});

	it("accepts the boolean and numeric strings validate-args lets through", async () => {
		const tool = toMcpTool(
			defineOperation({
				id: "probe",
				method: "GET",
				path: "/api/probe",
				domain: "probe",
				tier: "read",
				summary: "probe",
				keywords: [],
				input: z.object({ limit: z.number().optional(), stale: z.boolean().optional() }),
				run: async (_ctx, input) => input,
			})
		);
		const ctx = { role: "owner" } as never;
		expect(await tool.handler({ limit: "5", stale: "false" }, ctx)).toEqual({
			limit: 5,
			stale: false,
		});
		expect(await tool.handler({ stale: "1" }, ctx)).toEqual({ stale: true });
		await expect(tool.handler({ limit: "five" }, ctx)).rejects.toThrow();
	});

	const getIssues = (query: string) =>
		SELF.fetch(`http://localhost/api/issues?${query}`, { headers: authHeaders(token, slug) });

	it("rejects a key passed under both its name and its REST alias", async () => {
		const res = await getIssues("project=a&projectId=b");
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain("projectId");
	});

	it("advertises the defaults the service applies", () => {
		const tool = toMcpTool(issueOperations.find((op) => op.id === "get_prioritized_issues")!);
		const props = tool.inputSchema.properties as Record<string, { default?: unknown }>;
		expect(props.limit.default).toBe(10);
		expect(props.includeBacklog.default).toBe(true);
	});
});
