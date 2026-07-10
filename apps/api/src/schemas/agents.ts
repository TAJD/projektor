import { z } from "zod";

export const RegisterAgentSchema = z.object({
	issueId: z.string().uuid().optional(),
	name: z.string().min(1).max(200),
	// PROJ-336: deprecated — accepted for MCP client compatibility but ignored by
	// the service (see services/agents.ts). It was the original spoofable
	// review-gate signal; PROJ-287 rebound the gate to live leases instead.
	kind: z.enum(["agent", "human"]).optional(),
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
