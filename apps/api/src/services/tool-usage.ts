import { GetToolUsageSchema } from "../schemas/tool-usage";
import { ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

// PROJ-1055: per-workspace, per-UTC-day, per-tool MCP call counts and response sizes.
// Written by routes/mcp.ts after every tools/call (off the response path, best-effort);
// read by get_tool_usage / GET /api/tool-usage so agent token cost can be measured by
// tool. Aggregate counts only — no arguments, no results, no caller identity — so any
// workspace member may read them.

const DAY = 86_400;
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 25;

export function utcDayStart(epochSeconds: number): number {
	return Math.floor(epochSeconds / DAY) * DAY;
}

/** Upserts one call into today's row for (workspace, tool). */
export async function recordToolCall(
	db: D1Database,
	workspaceId: string,
	tool: string,
	responseBytes: number,
	isError: boolean,
	now: number = Math.floor(Date.now() / 1000)
): Promise<void> {
	await db
		.prepare(
			`INSERT INTO mcp_tool_usage (workspace_id, day, tool, calls, errors, response_bytes)
			 VALUES (?, ?, ?, 1, ?, ?)
			 ON CONFLICT (workspace_id, day, tool) DO UPDATE SET
			   calls = calls + 1,
			   errors = errors + excluded.errors,
			   response_bytes = response_bytes + excluded.response_bytes`
		)
		.bind(workspaceId, utcDayStart(now), tool, isError ? 1 : 0, responseBytes)
		.run();
}

interface UsageRow {
	tool: string;
	calls: number;
	errors: number;
	response_bytes: number;
}

export async function getToolUsage(ctx: ServiceCtx, raw: unknown) {
	const parsed = GetToolUsageSchema.safeParse(raw ?? {});
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const now = Math.floor(Date.now() / 1000);
	const until = parsed.data.until ?? now;
	const since = parsed.data.since ?? until - DEFAULT_WINDOW_DAYS * DAY;
	if (since > until) {
		throw new ValidationError({ formErrors: [], fieldErrors: { since: ["must be <= until"] } });
	}
	const limit = parsed.data.limit ?? DEFAULT_LIMIT;

	const where = ["workspace_id = ?", "day >= ?", "day <= ?"];
	const params: unknown[] = [ctx.workspaceId, utcDayStart(since), until];
	if (parsed.data.tool) {
		where.push("tool = ?");
		params.push(parsed.data.tool);
	}
	const { results } = await ctx.db
		.prepare(
			`SELECT tool, SUM(calls) AS calls, SUM(errors) AS errors,
			        SUM(response_bytes) AS response_bytes
			   FROM mcp_tool_usage
			  WHERE ${where.join(" AND ")}
			  GROUP BY tool
			  ORDER BY response_bytes DESC, tool ASC`
		)
		.bind(...params)
		.all<UsageRow>();
	const rows = results ?? [];

	const total = { calls: 0, errors: 0, responseBytes: 0 };
	for (const r of rows) {
		total.calls += r.calls;
		total.errors += r.errors;
		total.responseBytes += r.response_bytes;
	}
	return {
		since: utcDayStart(since),
		until,
		total,
		tools: rows.slice(0, limit).map((r) => ({
			tool: r.tool,
			calls: r.calls,
			errors: r.errors,
			responseBytes: r.response_bytes,
			avgResponseBytes: r.calls > 0 ? Math.round(r.response_bytes / r.calls) : 0,
		})),
		...(rows.length > limit ? { omittedTools: rows.length - limit } : {}),
	};
}
