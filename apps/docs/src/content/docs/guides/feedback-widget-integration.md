---
title: "Feedback widget integration"
description: "Collect end-user feedback from your own site and route it into a projektor project."
sidebar:
  order: 4
---
> **Note:** the code below is generated from [`apps/api/src/examples/feedback-widget-submit.ts`](https://github.com/TAJD/projektor/blob/main/apps/api/src/examples/feedback-widget-submit.ts) by `scripts/gen-feedback-example-page.ts`, and is executed against a live projektor instance in [`apps/api/src/test/feedback-example.test.ts`](https://github.com/TAJD/projektor/blob/main/apps/api/src/test/feedback-example.test.ts) - edit that source file, not this page, and run `pnpm gen:docs`.

A **feedback source** is a named, independently-credentialed collection point (e.g.
"Onboarding survey", "In-app rating widget") that a project owner or admin creates once.
Any number of sources can exist per project. Each source has its own public submit
token, so you can revoke or rotate one integration without touching another.

## 1. Create a feedback source

Ask an AI agent with MCP access to the workspace to run `create_feedback_source`, or
call the REST endpoint directly:

```bash
curl -X POST https://your-projektor-instance/api/projects/<projectId>/feedback-sources \
  -H "Authorization: Bearer <your workspace API token>" \
  -H "Content-Type: application/json" \
  -d '{"name": "In-app rating widget", "allowedOrigins": ["https://your-site.example"]}'
```

The response includes a one-time `token` - copy it now, it is never shown again. This
token is the trust boundary for the integration: it's deliberately public and safe to
ship in client-side code (the same category as a Sentry DSN or a Stripe publishable
key), narrow in scope (submit-only), and independently revocable/rotatable per source.

## 2. Submit feedback from your site

```ts
/**
 * Minimal, framework-agnostic example: submit end-user feedback from your own
 * product's client code to a projektor feedback source.
 *
 * This file is the single source of truth for the code block in
 * apps/docs/src/content/docs/guides/feedback-widget-integration.md (mirrored
 * in by scripts/gen-feedback-example-page.ts) and is executed against a real
 * projektor instance in apps/api/src/test/feedback-example.test.ts. If either
 * drifts from this file, CI fails — see the "Generated docs are fresh" step.
 */

export interface FeedbackPayload {
	/** -1 or 1 for a "thumbs" ratingScale, or 1-5 for "five_star". */
	rating?: number;
	ratingScale?: "thumbs" | "five_star";
	/** Free-text comment. At least one of rating or body is required. */
	body?: string;
	/** Optional label for who submitted this (e.g. an email or username). */
	submitterLabel?: string;
	/** Optional context URL — e.g. the page or generated-content URL this feedback is about. */
	sourceUrl?: string;
	appVersion?: string;
}

/**
 * POSTs to a projektor feedback source's public submit endpoint.
 *
 * `token` is the public submit token minted for a feedback source (via the
 * create_feedback_source MCP tool or the feedback-sources REST API) — it is
 * meant to be embedded in client-side code, the same trust category as a
 * Sentry DSN or a Stripe publishable key.
 */
export async function submitFeedback(
	endpoint: string,
	token: string,
	feedback: FeedbackPayload
): Promise<{ id: string }> {
	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(feedback),
	});
	if (!res.ok) {
		throw new Error(`Feedback submit failed: ${res.status} ${await res.text()}`);
	}
	return res.json();
}
```

Call it after whatever moment makes sense for your product - a thumbs up/down after
generating something, a rating prompt after a task completes, an in-app "send feedback"
form:

```ts
await submitFeedback("https://your-projektor-instance/api/feedback/submit", token, {
  rating: 1,
  ratingScale: "thumbs",
  sourceUrl: window.location.href,
});
```

`rating` and `body` are both optional, but at least one is required per submission.
`ratingScale` is required whenever `rating` is present ("thumbs": -1 or 1; "five_star":
1-5).

## 3. Triage feedback

Submitted feedback shows up on the project's Feedback page
(`/feedback/?projectId=<projectId>`), where workspace owners/admins can filter it by
status/source, mark it reviewed, or convert it directly into an issue.

## See also

- [MCP tool catalog](/projektor/agents/tool-catalog/) for the full set of
  feedback-source management tools (create/list/update/rotate/revoke)
- [REST endpoints](/projektor/agents/rest-endpoints/) - `POST /api/feedback/submit`
  is public and REST-only; there is no MCP equivalent for end-user submission
