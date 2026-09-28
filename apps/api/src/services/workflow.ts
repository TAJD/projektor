import { GetWorkflowSchema } from "../schemas/workflow";
import { ValidationError } from "./errors";
import { WORKFLOW_SPEC } from "./workflow-content";

// PROJ-933: agents re-fetch the ~1k token workflow spec every session even though it
// rarely changes. `version` is a stable content hash of everything get_workflow returns (title,
// description and body); a caller that
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

// The full returned payload, built once: the spec is a compile-time constant. The version
// hashes exactly this object, so a change to the title or description bumps it too.
const WORKFLOW_PAYLOAD = {
	title: WORKFLOW_SPEC.title,
	description: WORKFLOW_SPEC.description,
	content: WORKFLOW_SPEC.body.trim(),
};

// Hashed lazily once per isolate. Not exported directly — callers (including routes/mcp.ts's
// `initialize` instructions) go through getWorkflow() below, the one service entry point.
// A rejected hash is not cached, so a transient failure doesn't stick for the isolate.
let cachedVersion: Promise<string> | undefined;

function getWorkflowVersion(): Promise<string> {
	if (!cachedVersion) {
		cachedVersion = hashWorkflowContent(JSON.stringify(WORKFLOW_PAYLOAD)).catch((e) => {
			cachedVersion = undefined;
			throw e;
		});
	}
	return cachedVersion;
}

export async function getWorkflow(raw: unknown = {}) {
	const result = GetWorkflowSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { ifVersion } = result.data;

	const version = await getWorkflowVersion();
	if (ifVersion === version) {
		return { unchanged: true, version };
	}

	return { ...WORKFLOW_PAYLOAD, version };
}
