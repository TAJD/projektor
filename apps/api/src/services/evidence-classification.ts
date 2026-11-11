// PROJ-375: classifies a completion report's `verification` text as externally
// checkable or not — a heuristic, not a real check (no outbound call to GitHub here,
// that's the deferred "trusted CI/webhook" follow-up). A CI run URL, a PR URL, a
// commit/comparison URL, or a bare git SHA all point at something a human (or a
// future automated check) could independently open and verify; plain prose like
// "ran the tests locally" can't be resolved by anyone but the agent that wrote it.
const RESOLVABLE_URL_PATTERN = /https?:\/\/\S*\/(pull|pulls|actions\/runs|commit|compare)\/\S+/i;
// A bare SHA must mix digits and a-f letters. Hex-only matching also accepted plain
// numbers ("ran 1000000 iterations") and words ("defaced"). A real 7+ character SHA is
// all digits or all letters under 4% of the time, and a miss only flags the issue for
// audit, which is the safe direction.
const COMMIT_SHA_PATTERN = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i;

export function isExternallyVerifiableEvidence(verification: string): boolean {
	return RESOLVABLE_URL_PATTERN.test(verification) || COMMIT_SHA_PATTERN.test(verification);
}
