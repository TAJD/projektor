import { z } from "zod";

// PROJ-1055: read side of the MCP tool-usage telemetry.
export const GetToolUsageSchema = z
	.object({
		since: z.coerce.number().int().nonnegative().optional(),
		until: z.coerce.number().int().nonnegative().optional(),
		tool: z.string().min(1).max(100).optional(),
		limit: z.coerce.number().int().min(1).max(200).optional(),
	})
	.strict();
