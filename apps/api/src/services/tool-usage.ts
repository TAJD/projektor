import { GetToolUsageSchema } from "../schemas/tool-usage";
import { ValidationError } from "./errors";
import type { ServiceCtx } from "./types";

const DAY = 86_400;
const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_LIMIT = 25;

export function utcDayStart(epochSeconds: number): number {
	return Math.floor(epochSeconds / DAY) * DAY;
}

export async function getToolUsage(ctx: ServiceCtx, raw: unknown) {
	const parsed = GetToolUsageSchema.safeParse(raw ?? {});
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	const now = Math.floor(Date.now() / 1000);
	const until = parsed.data.until ?? now;
	const since = utcDayStart(parsed.data.since ?? until - DEFAULT_WINDOW_DAYS * DAY);
	if (since > until) {
		throw new ValidationError({ formErrors: [], fieldErrors: { since: ["must be <= until"] } });
	}
	const limit = parsed.data.limit ?? DEFAULT_LIMIT;

	const query = ctx.config?.mcpUsage;
	if (!query) {
		return {
			available: false as const,
			reason:
				"Tool usage is recorded to Workers Analytics Engine; this deployment has not configured " +
				"MCP_USAGE_DATASET, CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN for reading it back.",
			since,
			until,
		};
	}

	const rows = (await query({ since, until, tool: parsed.data.tool })).sort(
		(a, b) => b.responseBytes - a.responseBytes || a.tool.localeCompare(b.tool)
	);
	const total = { calls: 0, errors: 0, responseBytes: 0 };
	for (const r of rows) {
		total.calls += r.calls;
		total.errors += r.errors;
		total.responseBytes += r.responseBytes;
	}
	return {
		available: true as const,
		since,
		until,
		total,
		tools: rows.slice(0, limit).map((r) => ({
			...r,
			avgResponseBytes: r.calls > 0 ? Math.round(r.responseBytes / r.calls) : 0,
		})),
		...(rows.length > limit ? { omittedTools: rows.length - limit } : {}),
	};
}
