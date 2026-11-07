import { PLAIN_WRITE } from "../mcp/annotations";
import {
	ConvertFeedbackSchema,
	CreateFeedbackSourceSchema,
	GetFeedbackSourceSchema,
	ListFeedbackSchema,
	ListFeedbackSourcesSchema,
	RevokeFeedbackSourceSchema,
	RotateFeedbackSourceSchema,
	UpdateFeedbackSchema,
	UpdateFeedbackSourceSchema,
} from "../schemas/feedback";
import { convertFeedbackToIssue, listFeedback, updateFeedbackStatus } from "../services/feedback";
import {
	createFeedbackSource,
	getFeedbackSource,
	listFeedbackSources,
	revokeFeedbackSource,
	rotateFeedbackSourceToken,
	updateFeedbackSource,
} from "../services/feedback-sources";
import { defineOperation } from "./define";

const base = {
	domain: "feedback",
	keywords: ["feedback", "survey", "nps", "rating", "widget", "user research", "triage"],
};

const SOURCES = "/api/projects/:projectId/feedback-sources";
const FEEDBACK = "/api/projects/:projectId/feedback";

export const feedbackOperations = [
	defineOperation({
		...base,
		id: "create_feedback_source",
		method: "POST",
		path: SOURCES,
		tier: "write",
		status: 201,
		summary:
			"Create a feedback source for a project. A source is a named, independently-credentialed " +
			"feedback collection point (e.g. 'Onboarding survey', 'In-app NPS widget') that end-user " +
			"feedback is submitted against. Returns a raw token that must be embedded in the user's own " +
			"product code (a form or widget that POSTs to /api/feedback/submit with " +
			"'Authorization: Bearer <token>'). The raw token is shown exactly once and cannot be " +
			"retrieved later — relay it to the user immediately. Admin/owner only. Optionally restrict " +
			"browser callers with allowedOrigins (a list of allowed CORS origins); omit it for " +
			"server-to-server callers.",
		input: CreateFeedbackSourceSchema,
		run: (ctx, input) => createFeedbackSource(ctx, input),
	}),
	defineOperation({
		...base,
		id: "list_feedback_sources",
		method: "GET",
		path: SOURCES,
		tier: "read",
		summary:
			"List a project's feedback sources. Each entry includes id, name, description, whether " +
			"it is active, its allowed origins, a truncated token preview (never the raw token), and " +
			"created/revoked timestamps. Admin/owner only.",
		input: ListFeedbackSourcesSchema,
		run: (ctx, input) => listFeedbackSources(ctx, input),
	}),
	defineOperation({
		...base,
		id: "get_feedback_source",
		method: "GET",
		path: "/api/feedback-sources/:sourceId",
		tier: "read",
		summary:
			"Look up a single feedback source by id, including its projectId. Workspace-scoped: a " +
			"sourceId from another workspace 404s. Any workspace member can read.",
		input: GetFeedbackSourceSchema,
		run: (ctx, input) => getFeedbackSource(ctx, input),
	}),
	defineOperation({
		...base,
		id: "update_feedback_source",
		method: "PATCH",
		path: `${SOURCES}/:sourceId`,
		tier: "write",
		summary:
			"Update a feedback source's name, description, or active state. Setting isActive to false " +
			"is a kill switch: submissions against the source's token are immediately rejected (this is " +
			"reversible — set it back to true to resume; contrast with revoke_feedback_source, which is " +
			"permanent). Admin/owner only.",
		input: UpdateFeedbackSourceSchema,
		run: (ctx, input) => updateFeedbackSource(ctx, input),
	}),
	defineOperation({
		...base,
		id: "rotate_feedback_source_token",
		method: "POST",
		path: `${SOURCES}/:sourceId/rotate`,
		tier: "destructive",
		summary:
			"Generate a new token for a feedback source. Returns the new raw token once; the old token " +
			"stops working immediately. The source's identity (id), name, description, and all its " +
			"historical feedback are preserved — use this when a token has leaked or needs periodic " +
			"rotation. Relay the new token to the user so they can update their product code. Admin/owner only.",
		input: RotateFeedbackSourceSchema,
		run: (ctx, input) => rotateFeedbackSourceToken(ctx, input),
	}),
	defineOperation({
		...base,
		id: "revoke_feedback_source",
		method: "DELETE",
		path: `${SOURCES}/:sourceId`,
		tier: "destructive",
		summary:
			"Permanently revoke a feedback source. Its token stops working for good and it can never " +
			"accept another submission (its historical feedback is retained for reference). To replace " +
			"a revoked source, create a new one. Admin/owner only.",
		input: RevokeFeedbackSourceSchema,
		run: (ctx, input) => revokeFeedbackSource(ctx, input),
	}),
	defineOperation({
		...base,
		id: "list_feedback",
		method: "GET",
		path: FEEDBACK,
		tier: "read",
		summary:
			"List a project's submitted feedback (read/triage, not source management). Each entry " +
			"includes rating, ratingScale, body, submitterLabel, sourceUrl, appVersion, status " +
			"('new'/'reviewed'/'actioned'), linkedIssueId (set once converted to an issue), and " +
			"createdAt. Optionally filter by status or sourceId. Any project member (including " +
			"viewer) can read.",
		input: ListFeedbackSchema,
		run: (ctx, input) => listFeedback(ctx, input),
	}),
	defineOperation({
		...base,
		id: "update_feedback_status",
		method: "PATCH",
		path: `${FEEDBACK}/:feedbackId`,
		tier: "write",
		summary:
			"Update a feedback item's triage status ('new'/'reviewed'/'actioned'). Member+ (not viewer).",
		input: UpdateFeedbackSchema,
		run: (ctx, input) => updateFeedbackStatus(ctx, input),
	}),
	defineOperation({
		...base,
		id: "convert_feedback_to_issue",
		method: "POST",
		path: `${FEEDBACK}/:feedbackId/convert-to-issue`,
		tier: "write",
		annotations: PLAIN_WRITE,
		status: 201,
		summary:
			"Convert a feedback item into a tracked issue. The issue title comes from the feedback " +
			"body (or a rating-based fallback when there's no body); the feedback item is stamped " +
			"linkedIssueId and its status set to 'actioned'. Rejects (409) if the item was already " +
			"converted. Member+ (not viewer).",
		input: ConvertFeedbackSchema,
		run: (ctx, input) => convertFeedbackToIssue(ctx, input),
	}),
];
