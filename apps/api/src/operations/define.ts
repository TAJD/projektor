import type { HonoEnv, MCPTool, MCPToolAnnotations } from "@projektor/types";
import { Hono } from "hono";
import { z } from "zod";
import { jsonBody } from "../http/body";
import { serviceErrToResponse } from "../http/error-adapter";
import { CREATE, DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "../mcp/annotations";
import { ForbiddenError, ValidationError } from "../services/errors";
import { ctxFromHono, type ServiceCtx } from "../services/types";

export type Tier = "read" | "write" | "destructive" | "admin";

export interface Operation<S extends z.ZodObject = z.ZodObject> {
	id: string;
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	path: string;
	domain: string;
	tier: Tier;
	minRole?: "admin";
	summary: string;
	keywords: string[];
	input: S;
	status?: 200 | 201;
	run(ctx: ServiceCtx, input: z.output<S>): Promise<unknown>;
}

export function defineOperation<S extends z.ZodObject>(op: Operation<S>): Operation {
	return op as unknown as Operation;
}

function parseInput(op: Operation, ctx: ServiceCtx, raw: unknown) {
	if (op.minRole === "admin" && (ctx.role === "member" || ctx.role === "viewer")) {
		throw new ForbiddenError();
	}
	const parsed = op.input.safeParse(raw ?? {});
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	return parsed.data;
}

function annotationsFor(op: Operation): MCPToolAnnotations {
	if (op.tier === "read") return READ;
	if (op.tier === "destructive") return DESTRUCTIVE;
	return op.method === "POST" ? CREATE : IDEMPOTENT_WRITE;
}

export function toMcpTool(op: Operation): MCPTool {
	const { $schema: _, ...inputSchema } = z.toJSONSchema(op.input, {
		io: "input",
		override: ({ jsonSchema: s }) => {
			if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
			if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum;
		},
	});
	return {
		name: op.id,
		description: op.summary,
		inputSchema,
		annotations: annotationsFor(op),
		handler: (input, ctx) => op.run(ctx, parseInput(op, ctx, input)),
	};
}

export function operationsRouter(base: string, ops: Operation[]) {
	const router = new Hono<HonoEnv>();
	for (const op of ops) {
		if (!op.path.startsWith(base)) throw new Error(`${op.id}: ${op.path} is outside ${base}`);
		router.on(op.method, op.path.slice(base.length) || "/", async (c) => {
			try {
				const body =
					op.method === "GET" || op.method === "DELETE" ? c.req.query() : await jsonBody(c);
				const raw =
					typeof body === "object" && body !== null && !Array.isArray(body)
						? { ...body, ...c.req.param() }
						: body;
				const ctx = ctxFromHono(c);
				const result = await op.run(ctx, parseInput(op, ctx, raw));
				return c.json(result, op.status ?? 200);
			} catch (e) {
				return serviceErrToResponse(c, e);
			}
		});
	}
	return router;
}
