import { GetWorkflowSchema } from "../schemas/workflow";
import { ValidationError } from "./errors";
import { WORKFLOW_SPEC } from "./workflow-content";

// PROJ-933: agents re-fetch the ~1k token workflow spec every session even though it
// rarely changes. `version` is a stable content hash of the spec body; a caller that
// already holds it can pass it back as `ifVersion` and get `{ unchanged: true, version }`
// instead of the full spec.

const VERSION_HASH_LENGTH = 12;

/** Exported for unit testing — the hash must differ for different content and be stable
 * for the same content. */
export async function hashWorkflowContent(content: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
	const hex = Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return hex.slice(0, VERSION_HASH_LENGTH);
}

// The spec body is a static compile-time constant, so its hash never changes within a
// process. Computed once, lazily, on first use and cached at module level rather than
// re-hashed on every request. Not exported directly — callers (including routes/mcp.ts's
// `initialize` instructions) go through getWorkflow() below, the one service entry point.
let cachedVersion: Promise<string> | undefined;

function getWorkflowVersion(): Promise<string> {
	if (!cachedVersion) cachedVersion = hashWorkflowContent(WORKFLOW_SPEC.body.trim());
	return cachedVersion;
}

export async function getWorkflow(raw: unknown = {}) {
	const result = GetWorkflowSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { ifVersion } = result.data;

	const version = await getWorkflowVersion();
	if (ifVersion !== undefined && ifVersion === version) {
		return { unchanged: true, version };
	}

	return {
		title: WORKFLOW_SPEC.title,
		description: WORKFLOW_SPEC.description,
		content: WORKFLOW_SPEC.body.trim(),
		version,
	};
}
