import type { HonoEnv, MCPTool, MCPToolAnnotations } from "@projektor/types";
import { Hono } from "hono";
import { z } from "zod";
import { jsonBody } from "../http/body";
import { serviceErrToResponse } from "../http/error-adapter";
import { CREATE, DESTRUCTIVE, IDEMPOTENT_WRITE, READ } from "../mcp/annotations";
import { ForbiddenError, ValidationError } from "../services/errors";
import { ctxFromHono, type ServiceCtx } from "../services/types";
import { hashWorkflowContent } from "../services/workflow";

export type Tier = "read" | "write" | "destructive" | "admin";

export interface Operation<S extends z.ZodObject = z.ZodObject> {
	id: string;
	method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
	path: string;
	domain: string;
	tier: Tier;
	minRole?: "owner" | "admin" | "member";
	summary: string;
	keywords: string[];
	input: S;
	status?: 200 | 201 | 204;
	annotations?: MCPToolAnnotations;
	workspace?: false;
	bodyKey?: string;
	mcpDefaults?: Record<string, unknown>;
	restAliases?: Record<string, string>;
	headers?: (result: unknown) => Record<string, string>;
	versioned?: true;
	run(ctx: ServiceCtx, input: z.output<S>): Promise<unknown>;
	mcpResult?: (result: unknown, input: z.output<S>, ctx: ServiceCtx) => unknown;
}

export function defineOperation<S extends z.ZodObject>(op: Operation<S>): Operation {
	if (op.workspace === false && op.minRole) {
		throw new Error(`${op.id}: a workspace-less op has no role to check`);
	}
	return op as unknown as Operation;
}

const ROLE_RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

function requireRole(op: Operation, ctx: ServiceCtx) {
	if (op.minRole && ctx.role && ROLE_RANK[ctx.role] < ROLE_RANK[op.minRole]) {
		throw new ForbiddenError();
	}
}

function parseInput(op: Operation, ctx: ServiceCtx, raw: unknown) {
	requireRole(op, ctx);
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

const IfVersion = z
	.string()
	.optional()
	.meta({
		description:
			"The `version` from an earlier call with the same arguments. If the result is unchanged you get " +
			"{unchanged: true, version} instead of the full result",
	});

export function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
	const { $schema: _, ...jsonSchema } = z.toJSONSchema(schema, {
		io: "input",
		reused: "inline",
		override: ({ jsonSchema: s }) => {
			if (s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
			if (s.minimum === Number.MIN_SAFE_INTEGER) delete s.minimum;
			if (s.format === "uuid" || s.format === "email") delete s.pattern;
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
	return jsonSchema;
}

export function toMcpTool(op: Operation): MCPTool {
	const advertised = op.versioned ? op.input.extend({ ifVersion: IfVersion }) : op.input;
	const inputSchema = inputJsonSchema(advertised);
	const props = inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
	for (const [key, value] of Object.entries(op.mcpDefaults ?? {})) {
		if (props?.[key]) props[key].default = value;
	}
	return {
		name: op.id,
		description: op.summary,
		inputSchema,
		annotations: annotationsFor(op),
		handler: async (raw, ctx) => {
			let ifVersion: unknown;
			if (op.versioned && typeof raw === "object" && raw !== null) {
				({ ifVersion, ...raw } = raw as Record<string, unknown>);
				if (ifVersion != null && typeof ifVersion !== "string") {
					throw new ValidationError({
						formErrors: [],
						fieldErrors: { ifVersion: ["Expected a string"] },
					});
				}
			}
			const args = normalizeArgs(op.input, raw);
			const input = parseInput(
				op,
				ctx,
				op.mcpDefaults ? { ...op.mcpDefaults, ...(args as object) } : args
			);
			const result = await op.run(ctx, input);
			const output = op.mcpResult ? await op.mcpResult(result, input, ctx) : result;
			if (!op.versioned) return output;
			const version = await hashWorkflowContent(JSON.stringify(output));
			return ifVersion === version
				? { unchanged: true, version }
				: { ...(output as Record<string, unknown>), version };
		},
	};
}

function normalizeArgs(schema: z.ZodObject, raw: unknown) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const field = schema.shape[key] as z.ZodType | undefined;
		if (value === null && field && !field.safeParse(null).success) continue;
		out[key] = field ? coerceScalar(field, value) : value;
	}
	return out;
}

function coerceScalar(field: z.ZodType, value: unknown): unknown {
	if (typeof value !== "string") return value;
	const kind = baseType(field);
	if (kind === "number" && value.trim() !== "" && Number.isFinite(Number(value))) {
		return Number(value);
	}
	if (kind === "boolean" && (value === "true" || value === "1")) return true;
	if (kind === "boolean" && (value === "false" || value === "0" || value === "")) return false;
	return value;
}

function baseType(field: z.ZodType): string {
	let def = field._zod.def as { type: string; innerType?: z.ZodType };
	while (def.innerType && ["optional", "default", "nullable"].includes(def.type)) {
		def = def.innerType._zod.def as typeof def;
	}
	return def.type;
}

function aliasConflict(name: string, key: string) {
	return new ValidationError({
		formErrors: [],
		fieldErrors: { [key]: [`Pass ${key} once; "${name}" is another name for it`] },
	});
}

function fromQuery(
	schema: z.ZodObject,
	query: Record<string, string[]>,
	aliases: Record<string, string> = {}
) {
	const out: Record<string, unknown> = {};
	for (const [name, all] of Object.entries(query)) {
		const key = aliases[name] ?? name;
		const field = schema.shape[key] as z.ZodType | undefined;
		const values = all.filter((v) => v !== "");
		if (values.length === 0 || !field) continue;
		if (key in out) throw aliasConflict(name, key);
		if (baseType(field) === "array") out[key] = values;
		else out[key] = all.length > 1 ? all : coerceScalar(field, values[0]);
	}
	return out;
}

function renameKeys(body: unknown, aliases: Record<string, string> | undefined) {
	if (!aliases || typeof body !== "object" || body === null || Array.isArray(body)) return body;
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(body)) {
		const key = aliases[k] ?? k;
		if (key in out) throw aliasConflict(k, key);
		out[key] = v;
	}
	return out;
}

export function operationsRouter(base: string, ops: Operation[]) {
	const router = new Hono<HonoEnv>();
	for (const op of ops) {
		if (!op.path.startsWith(base)) throw new Error(`${op.id}: ${op.path} is outside ${base}`);
		router.on(op.method, op.path.slice(base.length) || "/", async (c) => {
			try {
				const ctx =
					op.workspace === false
						? ({
								db: c.env.DB,
								userId: (c.get("user") as { id: string } | undefined)?.id,
							} as ServiceCtx)
						: ctxFromHono(c);
				requireRole(op, ctx);
				const json = async () => ((await c.req.text()).trim() === "" ? {} : await jsonBody(c));
				const body =
					op.method === "GET" || op.method === "DELETE"
						? fromQuery(op.input, c.req.queries(), op.restAliases)
						: op.bodyKey
							? { [op.bodyKey]: await json() }
							: renameKeys(await json(), op.restAliases);
				const params = Object.fromEntries(
					Object.entries(c.req.param()).filter(([key]) => key in op.input.shape)
				);
				const raw =
					typeof body === "object" && body !== null && !Array.isArray(body)
						? { ...body, ...params }
						: body;
				const result = await op.run(ctx, parseInput(op, ctx, raw));
				if (op.status === 204) return c.body(null, 204);
				for (const [name, value] of Object.entries(op.headers?.(result) ?? {})) {
					c.header(name, value);
				}
				return c.json(result, op.status ?? 200);
			} catch (e) {
				return serviceErrToResponse(c, e);
			}
		});
	}
	return router;
}
