import type { MCPTool } from "@projektor/types";
import {
	createFeedbackSource,
	listFeedbackSources,
	revokeFeedbackSource,
	rotateFeedbackSourceToken,
	updateFeedbackSource,
} from "../services/feedback-sources";
import type { ServiceCtx } from "../services/types";

export const feedbackTools: MCPTool[] = [
	{
		name: "create_feedback_source",
		description:
			"Create a feedback source for a project. A source is a named, independently-credentialed " +
			"feedback collection point (e.g. 'Onboarding survey', 'In-app NPS widget') that end-user " +
			"feedback is submitted against. Returns a raw token that must be embedded in the user's own " +
			"product code (a form or widget that POSTs to /api/feedback/submit with " +
			"'Authorization: Bearer <token>'). The raw token is shown exactly once and cannot be " +
			"retrieved later — relay it to the user immediately. Admin/owner only. Optionally restrict " +
			"browser callers with allowedOrigins (a list of allowed CORS origins); omit it for " +
			"server-to-server callers.",
		inputSchema: {
			type: "object",
			required: ["projectId", "name"],
			properties: {
				projectId: { type: "string", description: "UUID of the project this source belongs to" },
				name: { type: "string", minLength: 1, maxLength: 100 },
				description: { type: "string", maxLength: 500 },
				allowedOrigins: {
					type: "array",
					items: { type: "string", maxLength: 2000 },
					description: "Allowed CORS origins for browser submission; omit for no restriction",
				},
			},
		},
		async handler(input, ctx) {
			return createFeedbackSource(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "list_feedback_sources",
		description:
			"List a project's feedback sources. Each entry includes id, name, description, whether " +
			"it is active, its allowed origins, a truncated token preview (never the raw token), and " +
			"created/revoked timestamps. Admin/owner only.",
		inputSchema: {
			type: "object",
			required: ["projectId"],
			properties: { projectId: { type: "string" } },
		},
		async handler(input, ctx) {
			return listFeedbackSources(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "update_feedback_source",
		description:
			"Update a feedback source's name, description, or active state. Setting isActive to false " +
			"is a kill switch: submissions against the source's token are immediately rejected (this is " +
			"reversible — set it back to true to resume; contrast with revoke_feedback_source, which is " +
			"permanent). Admin/owner only.",
		inputSchema: {
			type: "object",
			required: ["sourceId"],
			properties: {
				sourceId: { type: "string" },
				name: { type: "string", minLength: 1, maxLength: 100 },
				description: { type: "string", maxLength: 500 },
				isActive: { type: "boolean" },
			},
		},
		async handler(input, ctx) {
			return updateFeedbackSource(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "rotate_feedback_source_token",
		description:
			"Generate a new token for a feedback source. Returns the new raw token once; the old token " +
			"stops working immediately. The source's identity (id), name, description, and all its " +
			"historical feedback are preserved — use this when a token has leaked or needs periodic " +
			"rotation. Relay the new token to the user so they can update their product code. Admin/owner only.",
		inputSchema: {
			type: "object",
			required: ["sourceId"],
			properties: { sourceId: { type: "string" } },
		},
		async handler(input, ctx) {
			return rotateFeedbackSourceToken(ctx as unknown as ServiceCtx, input);
		},
	},
	{
		name: "revoke_feedback_source",
		description:
			"Permanently revoke a feedback source. Its token stops working for good and it can never " +
			"accept another submission (its historical feedback is retained for reference). To replace " +
			"a revoked source, create a new one. Admin/owner only.",
		inputSchema: {
			type: "object",
			required: ["sourceId"],
			properties: { sourceId: { type: "string" } },
		},
		async handler(input, ctx) {
			return revokeFeedbackSource(ctx as unknown as ServiceCtx, input);
		},
	},
];
