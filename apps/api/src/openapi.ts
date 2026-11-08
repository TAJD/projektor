import type { z } from "zod";
import { agentMessageOperations } from "./operations/agent-messages";
import { agentOperations } from "./operations/agents";
import { codeHeatmapOperations } from "./operations/code-heatmap";
import { commentOperations } from "./operations/comments";
import { customFieldOperations } from "./operations/custom-fields";
import { inputJsonSchema, type Operation } from "./operations/define";
import { feedbackOperations } from "./operations/feedback";
import { fileClaimOperations } from "./operations/file-claims";
import { fileOperations } from "./operations/files";
import { flowMetricsOperations } from "./operations/flow-metrics";
import { groupOperations } from "./operations/groups";
import { issueLeaseOperations } from "./operations/issue-leases";
import { issueLinkOperations } from "./operations/issue-links";
import { issueOperations } from "./operations/issues";
import { linkPreviewOperations } from "./operations/link-previews";
import { playbookOperations } from "./operations/playbooks";
import { projectActivityOperations } from "./operations/project-activity";
import { projectOperations } from "./operations/projects";
import { sprintOperations } from "./operations/sprints";
import { taskStatusOperations } from "./operations/task-statuses";
import { taskTypeOperations } from "./operations/task-types";
import { toolUsageOperations } from "./operations/tool-usage";
import { wikiOperations } from "./operations/wiki";
import { workflowOperations } from "./operations/workflow";
import { workspaceOperations } from "./operations/workspaces";

export const ALL_OPERATIONS: readonly Operation[] = [
	...agentMessageOperations,
	...agentOperations,
	...codeHeatmapOperations,
	...commentOperations,
	...customFieldOperations,
	...feedbackOperations,
	...fileClaimOperations,
	...fileOperations,
	...flowMetricsOperations,
	...groupOperations,
	...issueLeaseOperations,
	...issueLinkOperations,
	...issueOperations,
	...linkPreviewOperations,
	...playbookOperations,
	...projectActivityOperations,
	...projectOperations,
	...sprintOperations,
	...taskStatusOperations,
	...taskTypeOperations,
	...toolUsageOperations,
	...wikiOperations,
	...workflowOperations,
	...workspaceOperations,
];

type JsonSchema = Record<string, unknown> & {
	properties?: Record<string, JsonSchema>;
	required?: string[];
};

const PATH_PARAM = /:(\w+)(\{[^}]*\})?/g;

const byCodePoint = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function pathParams(path: string): string[] {
	return [...path.matchAll(PATH_PARAM)].map((m) => m[1]);
}

function firstSentence(text: string, max = 140): string {
	const end = text.search(/[.;:](\s|$)|\s—\s/);
	const sentence = (end === -1 ? text : text.slice(0, end)).trim();
	return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

function refineMessages(schema: z.ZodType): string[] {
	const checks = (schema._zod.def as { checks?: Array<{ _zod: { def: Record<string, unknown> } }> })
		.checks;
	const messages: string[] = [];
	for (const check of checks ?? []) {
		const def = check._zod.def;
		if (def.check !== "custom" || typeof def.error !== "function") continue;
		const message = (def.error as (issue: unknown) => unknown)({ code: "custom", input: {} });
		if (typeof message === "string" && message !== "") messages.push(message);
	}
	return messages;
}

function withoutKeys(schema: JsonSchema, keys: string[]): JsonSchema {
	if (keys.length === 0 || !schema.properties) return schema;
	const properties = Object.fromEntries(
		Object.entries(schema.properties).filter(([name]) => !keys.includes(name))
	);
	const required = schema.required?.filter((name) => !keys.includes(name));
	return {
		...schema,
		properties,
		...(required && required.length > 0 ? { required } : { required: undefined }),
	};
}

function parameter(name: string, where: "path" | "query", schema: JsonSchema, required: boolean) {
	const { description, ...rest } = schema;
	return {
		name,
		in: where,
		required: where === "path" || required,
		...(typeof description === "string" ? { description } : {}),
		schema: rest,
	};
}

const errorResponse = { $ref: "#/components/responses/Error" };

function operationObject(op: Operation, specNames: string[]) {
	const schema = inputJsonSchema(op.input) as JsonSchema;
	const inPath = pathParams(op.path);
	const required = new Set(schema.required ?? []);
	const properties = schema.properties ?? {};
	const parameters: unknown[] = inPath.map((name, i) =>
		parameter(specNames[i], "path", properties[name] ?? { type: "string" }, true)
	);
	if (op.workspace !== false && !/^\/api\/workspaces\/:/.test(op.path)) {
		parameters.push({ $ref: "#/components/parameters/WorkspaceSlug" });
	}
	let requestBody: unknown;
	if (op.method === "GET" || op.method === "DELETE") {
		for (const [name, prop] of Object.entries(properties)) {
			if (!inPath.includes(name)) {
				parameters.push(parameter(name, "query", prop, required.has(name)));
			}
		}
	} else {
		const body = op.bodyKey ? (properties[op.bodyKey] ?? {}) : withoutKeys(schema, inPath);
		requestBody = {
			required: op.bodyKey ? required.has(op.bodyKey) : (body.required?.length ?? 0) > 0,
			content: { "application/json": { schema: body } },
		};
	}
	const constraints = refineMessages(op.input);
	const status = op.status ?? 200;
	return {
		operationId: op.id,
		tags: [op.domain],
		summary: firstSentence(op.summary),
		description:
			constraints.length > 0
				? `${op.summary}\n\nConstraints: ${constraints.join("; ")}.`
				: op.summary,
		...(parameters.length > 0 ? { parameters } : {}),
		...(requestBody ? { requestBody } : {}),
		responses: {
			[status]:
				status === 204
					? { description: "No content" }
					: {
							description: "OK",
							content: { "application/json": { schema: {} } },
						},
			"400": errorResponse,
			"401": errorResponse,
			"403": errorResponse,
			"404": errorResponse,
			"409": errorResponse,
		},
		"x-tier": op.tier,
		...(op.minRole ? { "x-min-role": op.minRole } : {}),
		"x-keywords": op.keywords,
	};
}

export function buildOpenApi(ops: readonly Operation[] = ALL_OPERATIONS) {
	const paths: Record<string, Record<string, unknown>> = {};
	const byShape = new Map<string, string>();
	for (const op of ops) {
		const shape = op.path.replace(PATH_PARAM, "{}");
		if (!byShape.has(shape)) byShape.set(shape, op.path.replace(PATH_PARAM, "{$1}"));
		const path = byShape.get(shape) as string;
		const specNames = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
		paths[path] ??= {};
		paths[path][op.method.toLowerCase()] = operationObject(op, specNames);
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "Projektor API",
			version: "1.0.0",
			description:
				"Generated from the operation registry (apps/api/src/operations). Every operation here is also an MCP tool with the same name as its operationId. Path parameters are positional: where two operations share a path shape, the spec uses one set of names for both.",
		},
		servers: [{ url: "/" }],
		security: [{ bearerAuth: [] }],
		paths: Object.fromEntries(Object.entries(paths).sort(([a], [b]) => byCodePoint(a, b))),
		components: {
			securitySchemes: {
				bearerAuth: {
					type: "http",
					scheme: "bearer",
					description: "A workspace API token or personal access token",
				},
			},
			parameters: {
				WorkspaceSlug: {
					name: "X-Workspace-Slug",
					in: "header",
					required: false,
					description:
						"The workspace to act in. Required unless the request's host names the workspace",
					schema: { type: "string" },
				},
			},
			responses: {
				Error: {
					description:
						"`error` is a message, or for a 400 the per-field problems ({formErrors, fieldErrors}); a 404 or 409 may add details",
					content: {
						"application/json": {
							schema: {
								type: "object",
								properties: { error: {} },
								required: ["error"],
							},
						},
					},
				},
			},
		},
	};
}

type IndexEntry = {
	id: string;
	tier: Operation["tier"];
	summary: string;
	params: string[];
	keywords?: string[];
};

export function buildSearchIndex(ops: readonly Operation[] = ALL_OPERATIONS) {
	const domains: Record<string, { keywords: string[]; ops: IndexEntry[] }> = {};
	for (const op of [...ops].sort((a, b) => byCodePoint(a.id, b.id))) {
		domains[op.domain] ??= { keywords: op.keywords, ops: [] };
		const shared = domains[op.domain].keywords.join("\n") === op.keywords.join("\n");
		domains[op.domain].ops.push({
			id: op.id,
			tier: op.tier,
			summary: firstSentence(op.summary, 100),
			params: Object.keys(op.input.shape),
			...(shared ? {} : { keywords: op.keywords }),
		});
	}
	return {
		domains: Object.fromEntries(Object.entries(domains).sort(([a], [b]) => byCodePoint(a, b))),
	};
}
