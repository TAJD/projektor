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
// cofferdam-ignore: Design.DuplicateExportName: mirrors feedback.ts's submitFeedback name; never imported together
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
