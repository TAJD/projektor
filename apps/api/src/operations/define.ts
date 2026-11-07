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
	minRole?: "admin" | "member";
	summary: string;
	keywords: string[];
	input: S;
	status?: 200 | 201;
	annotations?: MCPToolAnnotations;
	workspace?: false;
	bodyKey?: string;
	run(ctx: ServiceCtx, input: z.output<S>): Promise<unknown>;
	mcpResult?: (result: unknown, input: z.output<S>, ctx: ServiceCtx) => unknown;
}

export function defineOperation<S extends z.ZodObject>(op: Operation<S>): Operation {
	return op as unknown as Operation;
}

function parseInput(op: Operation, ctx: ServiceCtx, raw: unknown) {
	if (
		(op.minRole === "admin" && ctx.role === "member") ||
		(op.minRole !== undefined && ctx.role === "viewer")
	) {
		throw new ForbiddenError();
	}
	const parsed = op.input.safeParse(raw ?? {});
	if (!parsed.success) throw new ValidationError(parsed.error.flatten());
	return parsed.data;
}

function annotationsFor(op: Operation): MCPToolAnnotations {
	if (op.annotations) return op.annotations;
	if (op.tier === "read") return READ;
	if (op.tier === "destructive") return DESTRUCTIVE;
	return op.method === "POST" ? CREATE : IDEMPOTENT_WRITE;
}

export function toMcpTool(op: Operation): MCPTool {
	const { $schema: _, ...inputSchema } = z.toJSONSchema(op.input, {
		io: "input",
		reused: "inline",
		override: ({ jsonSchema: s }) => {
			if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
			if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum;
			if (s.format === "uuid") delete s.pattern;
			const variants = s.anyOf;
			if (variants?.length === 2 && variants.some((v) => v.type === "null")) {
				const other = variants.find((v) => v.type !== "null");
				if (typeof other?.type === "string") {
					delete s.anyOf;
					Object.assign(s, other, { type: [other.type, "null"] });
				}
			}
		},
	});
	return {
		name: op.id,
		description: op.summary,
		inputSchema,
		annotations: annotationsFor(op),
		handler: async (raw, ctx) => {
			const input = parseInput(op, ctx, dropRejectedNulls(op.input, raw));
			const result = await op.run(ctx, input);
			return op.mcpResult ? op.mcpResult(result, input, ctx) : result;
		},
	};
}

function dropRejectedNulls(schema: z.ZodObject, raw: unknown) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const field = schema.shape[key] as z.ZodType | undefined;
		if (value === null && field && !field.safeParse(null).success) continue;
		out[key] = value;
	}
	return out;
}

function baseType(field: z.ZodType): string {
	let def = field._zod.def as { type: string; innerType?: z.ZodType };
	while (def.innerType && ["optional", "default", "nullable"].includes(def.type)) {
		def = def.innerType._zod.def as typeof def;
	}
	return def.type;
}

function fromQuery(schema: z.ZodObject, query: Record<string, string[]>) {
	const out: Record<string, unknown> = {};
	for (const [key, all] of Object.entries(query)) {
		const field = schema.shape[key] as z.ZodType | undefined;
		const values = all.filter((v) => v !== "");
		if (values.length === 0 || !field) continue;
		const kind = baseType(field);
		const value = values[0];
		if (kind === "array" || values.length > 1) out[key] = values;
		else if (kind === "number") out[key] = Number(value);
		else if (kind === "boolean" && (value === "true" || value === "1")) out[key] = true;
		else if (kind === "boolean" && (value === "false" || value === "0")) out[key] = false;
		else out[key] = value;
	}
	return out;
}

export function operationsRouter(base: string, ops: Operation[]) {
	const router = new Hono<HonoEnv>();
	for (const op of ops) {
		if (!op.path.startsWith(base)) throw new Error(`${op.id}: ${op.path} is outside ${base}`);
		router.on(op.method, op.path.slice(base.length) || "/", async (c) => {
			try {
				const body =
					op.method === "GET" || op.method === "DELETE"
						? fromQuery(op.input, c.req.queries())
						: op.bodyKey
							? { [op.bodyKey]: await jsonBody(c) }
							: await jsonBody(c);
				const raw =
					typeof body === "object" && body !== null && !Array.isArray(body)
						? { ...body, ...c.req.param() }
						: body;
				const ctx = op.workspace === false ? ({} as ServiceCtx) : ctxFromHono(c);
				const result = await op.run(ctx, parseInput(op, ctx, raw));
				return c.json(result, op.status ?? 200);
			} catch (e) {
				return serviceErrToResponse(c, e);
			}
		});
	}
	return router;
}
