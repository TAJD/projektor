import { z } from "zod";

export const RegisterAgentSchema = z.object({
	issueId: z.string().uuid().optional(),
	name: z.string().min(1).max(200),
	kind: z.enum(["agent", "human"]).optional().default("agent"),
});

export const HeartbeatAgentSchema = z.object({
	id: z.string().uuid(),
});

export const EndAgentSchema = z.object({
	id: z.string().uuid(),
});

export const ListActiveAgentsSchema = z.object({
	issueId: z.string().uuid().optional(),
});
