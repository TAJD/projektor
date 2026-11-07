import type { Env, HonoEnv, McpUsageFilter, McpUsageRow } from "@projektor/types";
import type { Context } from "hono";

const SQL_SAFE = /^[A-Za-z0-9_.:-]+$/;

export function mcpUsageQuery(
	env: Pick<Env, "CF_ACCOUNT_ID" | "CF_ANALYTICS_TOKEN" | "MCP_USAGE_DATASET">,
	workspaceId: string
): ((filter: McpUsageFilter) => Promise<McpUsageRow[]>) | undefined {
	const { CF_ACCOUNT_ID: account, CF_ANALYTICS_TOKEN: token, MCP_USAGE_DATASET: dataset } = env;
	if (!account || !token || !dataset) return undefined;
	return async ({ since, until, tool }) => {
		if (!SQL_SAFE.test(dataset) || !SQL_SAFE.test(workspaceId)) return [];
		if (tool !== undefined && !SQL_SAFE.test(tool)) return [];
		const sql = `SELECT blob1 AS tool, SUM(_sample_interval) AS calls,
  SUM(_sample_interval * double4) AS errors, SUM(_sample_interval * double2) AS response_bytes
FROM ${dataset}
WHERE index1 = '${workspaceId}' AND blob10 = 'tools/call'
  AND timestamp >= toDateTime(${Math.trunc(since)}) AND timestamp <= toDateTime(${Math.trunc(until)})${tool ? ` AND blob1 = '${tool}'` : ""}
GROUP BY tool
FORMAT JSON`;
		const res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`,
			{ method: "POST", headers: { Authorization: `Bearer ${token}` }, body: sql }
		);
		if (!res.ok) throw new Error(`analytics engine query failed: ${res.status}`);
		const { data } = (await res.json()) as {
			data: Array<{ tool: string; calls: unknown; errors: unknown; response_bytes: unknown }>;
		};
		return data.map((r) => ({
			tool: r.tool,
			calls: Number(r.calls),
			errors: Number(r.errors),
			responseBytes: Number(r.response_bytes),
		}));
	};
}

export interface McpCallEvent {
	workspaceId: string;
	method: "tools/call" | "prompts/get";
	name: string;
	outcome: string;
	isError: boolean;
	latencyMs: number;
	responseBytes: number;
	argBytes: number;
	version: string;
}

const utf8 = new TextEncoder();

export function byteLength(value: unknown): number {
	if (value === undefined) return 0;
	return utf8.encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

export function toolErrorCode(result: unknown): string {
	const text = (result as { content?: Array<{ text?: string }> } | null)?.content?.[0]?.text;
	if (!text) return "internal";
	try {
		return (JSON.parse(text) as { error?: { code?: string } }).error?.code ?? "error";
	} catch {
		return "error";
	}
}

export function emitCallEvent(c: Context<HonoEnv>, evt: McpCallEvent): void {
	try {
		const auth = c.get("auth");
		const credentialId = auth?.credentialId ?? "";
		const clientId = auth?.clientId ?? "";
		const authMethod = auth?.method ?? "";
		const userId = c.get("user")?.id ?? "";
		const surface = c.req.query("domains") ? "domains" : "full";
		console.log(
			JSON.stringify({
				evt: "mcp_call",
				...evt,
				surface,
				authMethod,
				credentialId,
				clientId,
				userId,
			})
		);
		c.env.MCP_USAGE?.writeDataPoint({
			indexes: [evt.workspaceId],
			blobs: [
				evt.name,
				"",
				surface,
				authMethod,
				credentialId,
				clientId,
				userId,
				evt.outcome,
				evt.version,
				evt.method,
			],
			doubles: [evt.latencyMs, evt.responseBytes, evt.argBytes, evt.isError ? 1 : 0],
		});
	} catch (err) {
		console.error("mcp usage event failed (PROJ-886)", err instanceof Error ? err.message : err);
	}
}
