// PROJ-623: mechanical parity across the four tool surfaces.
//
// Parity used to be held by convention plus two hand-written spot checks in mcp.test.ts
// (issues and wiki — 2 of 22 domains), and mcp/catalog.ts carried a comment asking a
// human to keep its order in sync with the runtime registry by hand. This test replaces
// both with a check that fails the build.
//
// The four surfaces:
//   1. service functions   src/services/*.ts   — the operations that exist at all
//   2. REST routes         src/routes/*.ts     — the browser/HTTP surface
//   3. runtime MCP registry src/routes/mcp.ts  — what tools/call can actually dispatch
//   4. docs catalog        src/mcp/catalog.ts  — what the generated tool catalog documents
//
// This runs in node, not workerd: it reads the repo's own source off disk, and workerd
// has no node:fs. See the `projects` block in vitest.config.mts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_DOMAINS } from "../mcp/catalog";
import { coreMCPTools } from "../routes/mcp";

const SRC = join(import.meta.dirname, "..");

// ---------------------------------------------------------------------------
// Deliberate exceptions.
//
// Note what is NOT here: internal helpers. A service function referenced by neither
// src/mcp nor src/routes is internal *by construction*, so it needs no entry — which is
// why this list stays short as the codebase grows. Only an operation deliberately
// exposed on one surface but not the other has to be named, and every name carries its
// reason. A stale entry (one that no longer applies) fails the test too, so the list
// shrinks when a gap is closed instead of quietly rotting.
// ---------------------------------------------------------------------------

/** MCP tools with no REST equivalent. Each is a real parity gap, tracked in PROJ-633. */
const MCP_ONLY: Record<string, string> = {
	"projects.ts:listProjects":
		"workspace-scoped list; the REST surface serves the cross-workspace listProjectsAcrossWorkspaces instead",
};

/**
 * REST operations with no MCP tool. Browser-only by design unless noted — auth, upload
 * plumbing, and public ingest have no agent-facing meaning.
 */
const REST_ONLY: Record<string, string> = {
	// Auth / token plumbing — an agent authenticates, it does not mint credentials.
	"types.ts:ctxFromHono": "adapter from Hono context to ServiceCtx, not an operation",
	"user-tokens.ts:getUserWorkspaces": "session bootstrap for the browser",
	"user-tokens.ts:createUserToken": "personal access tokens are minted by a human in the UI",
	"user-tokens.ts:deleteUserToken": "revoking a human's own PAT is a UI action",
	"workspaces.ts:createToken": "workspace API tokens are minted by a human in the UI",
	"workspaces.ts:listTokens": "token inventory is a human audit view",
	"workspaces.ts:revokeToken": "revoking a workspace token is a human action",
	"workspaces.ts:getWorkspaceMcpInfo": "connection instructions for a human setting up a client",
	// Public share links — issued by a human, consumed anonymously.
	"share.ts:createShareToken": "public share links are issued by a human",
	"share.ts:getSharedIssue": "anonymous read path, no workspace auth",
	"share.ts:revokeShareToken": "revoking a public share link is a human action",
	// Upload plumbing — multipart/quota mechanics, not operations.
	"files.ts:storageQuotaBytes": "quota arithmetic used by the upload route",
	"files.ts:assertUploadAllowed": "upload precondition check",
	"files.ts:recordUpload": "second half of the multipart upload handshake",
	"files.ts:getAttachmentForDownload":
		"streams bytes for the browser; the metadata-shaped read is getAttachment, on both surfaces",
	// Feedback: public ingest is anonymous, triage is a human review queue.
	"feedback.ts:hashFeedbackToken": "ingest token hashing",
	"feedback.ts:submitFeedback": "anonymous public ingest, no workspace auth",
	"feedback.ts:bulkMarkReviewed": "human triage action (PROJ-634)",
	"feedback.ts:bulkConvertToIssue": "human triage action (PROJ-634)",
	"feedback.ts:getFeedbackSummary": "human triage dashboard (PROJ-634)",
	// Bootstrap seeds — called by GET /bootstrap in index.ts to populate a new workspace's
	// defaults. Not operations a client invokes; they only run as part of provisioning.
	"custom-fields.ts:seedDefaultCustomFields": "bootstrap seed for a new workspace",
	"task-statuses.ts:seedDefaultTaskStatuses": "bootstrap seed for a new workspace",
	"task-types.ts:seedDefaultTaskTypes": "bootstrap seed for a new workspace",
	// OAuth consent (PROJ-656) — the browser-only half of the connector flow. An agent
	// is the *subject* of these, never the caller: it cannot decide who may connect it.
	"oauth.ts:parseConsentRequest": "validates a browser authorization request before consent",
	"oauth.ts:lookupConsentWorkspace": "membership check for the human on the consent screen",
	"oauth.ts:describeScope": "consent-screen copy",
	"oauth.ts:relyingPartyHost": "consent-screen copy",
	"oauth.ts:isLoopbackOnlyClient": "consent-screen warning",
	"oauth.ts:listConnectorGrants": "settings-only: a connector must not enumerate credentials",
	"oauth.ts:revokeConnectorGrant": "settings-only: revoking a credential is a browser action",
	// Misc.
	"issues.ts:resolveIssueIdParam": "URL param coercion, not an operation",
	"projects.ts:getProjectBySlug": "slug routing for the browser; agents address projects by id",
	"projects.ts:listProjectsAcrossWorkspaces":
		"cross-workspace summary for the browser's project switcher; MCP is scoped to one workspace per endpoint",
	"wiki-export.ts:exportWiki": "file download response, not a JSON operation",
};

/**
 * Tools whose name deliberately differs from snake_case(serviceFunction). The tool name
 * is the public contract and reads better; the service name is internal.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
	"issue-links.ts:createLink": "create_issue_link",
	"issue-links.ts:deleteLink": "delete_issue_link",
	"issue-links.ts:listLinksForIssue": "list_issue_links",
	"wiki.ts:getWikiBacklinks": "get_backlinks",
	"wiki.ts:listStaleWikiPages": "list_stale_pages",
	"wiki.ts:purgeExpiredWikiPages": "purge_wiki_trash",
	"wiki.ts:getWikiTree": "wiki_tree",
	"workspaces.ts:getWorkspaceWithMembers": "list_members",
};

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

function tsFiles(dir: string): string[] {
	return readdirSync(dir).filter((f) => f.endsWith(".ts"));
}

/** A directory expands to its .ts files; a file path is taken as-is. */
function expandToFiles(path: string): string[] {
	return path.endsWith(".ts") ? [path] : tsFiles(path).map((f) => join(path, f));
}

function snakeCase(name: string): string {
	return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/**
 * Every service identifier referenced by any file in `dir`, covering the binding styles
 * that can wire a surface up: named (`import { listIssues } from "../services/issues"`),
 * re-export (`export { listIssues } from "../services/issues"`), and namespace
 * (`import * as wikiService` then `wikiService.listWikiPages(...)`).
 *
 * The re-export form isn't used in this codebase today, but it binds a service function
 * to a surface just as effectively as an import, and missing it would be a false
 * negative — the one failure mode this test cannot afford.
 */
function serviceIdentifiersUsedIn(...paths: string[]): Set<string> {
	const names = new Set<string>();
	for (const path of paths.flatMap(expandToFiles)) {
		const src = readFileSync(path, "utf8");
		for (const m of src.matchAll(
			/(?:import|export)\s*(?:type\s*)?\{([^}]+)\}\s*from\s*"[^"]*services\/[^"]+"/g
		)) {
			for (const part of m[1].split(",")) {
				const id = part
					.trim()
					.replace(/^type\s+/, "")
					.split(/\s+as\s+/)[0]
					.trim();
				if (id) names.add(id);
			}
		}
		for (const m of src.matchAll(
			/import\s*\*\s*as\s+([A-Za-z0-9_$]+)\s*from\s*"[^"]*services\/[^"]+"/g
		)) {
			for (const use of src.matchAll(new RegExp(`\\b${m[1]}\\.([A-Za-z0-9_$]+)`, "g"))) {
				names.add(use[1]);
			}
		}
	}
	return names;
}

interface ServiceFn {
	/** `issues.ts:listIssues` — the key used by every exception map above. */
	key: string;
	fn: string;
	onMcp: boolean;
	onRest: boolean;
}

// index.ts is part of the REST surface, not just app wiring: it registers eight endpoints
// directly, three of which call service functions (GET/POST /api/workspaces, GET
// /api/projects). Scanning only routes/ made those read as unwired, which is how two
// MCP_ONLY entries came to claim a REST equivalent was missing when one existed, and how
// listAllProjects got swallowed by the internal-by-construction rule. PROJ-638.
const restIdentifiers = serviceIdentifiersUsedIn(join(SRC, "routes"), join(SRC, "index.ts"));
const mcpIdentifiers = serviceIdentifiersUsedIn(join(SRC, "mcp"));

const serviceFns: ServiceFn[] = [];
for (const file of tsFiles(join(SRC, "services"))) {
	const src = readFileSync(join(SRC, "services", file), "utf8");
	for (const m of src.matchAll(/^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)/gm)) {
		const fn = m[1];
		serviceFns.push({
			key: `${file}:${fn}`,
			fn,
			onMcp: mcpIdentifiers.has(fn),
			onRest: restIdentifiers.has(fn),
		});
	}
}

const catalogToolNames = TOOL_DOMAINS.flatMap((d) => d.tools.map((t) => t.name));
const runtimeToolNames = coreMCPTools.map((t) => t.name);

// ---------------------------------------------------------------------------

describe("MCP surface parity (PROJ-623)", () => {
	it("finds the source it is meant to be checking", () => {
		// Guards against the scanners silently matching nothing — a regex that stops
		// matching would otherwise turn every assertion below into a vacuous pass.
		expect(serviceFns.length).toBeGreaterThan(150);
		expect(restIdentifiers.size).toBeGreaterThan(50);
		expect(mcpIdentifiers.size).toBeGreaterThan(50);
		expect(catalogToolNames.length).toBeGreaterThan(100);
	});

	it("sees the REST surface registered in index.ts, not just routes/", () => {
		// PROJ-638: listProjectsAcrossWorkspaces is wired only by GET /api/projects in
		// index.ts. When the scan covered routes/ alone it read as unwired, so the
		// internal-by-construction rule swallowed it and two MCP_ONLY entries wrongly
		// claimed no REST equivalent existed. Naming a specific index.ts-only identifier
		// makes that regression fail here rather than resurface as a false parity gap.
		expect(restIdentifiers.has("listProjectsAcrossWorkspaces")).toBe(true);
		expect(restIdentifiers.has("createWorkspace")).toBe(true);
	});

	it("has no service function name exported from two different files", () => {
		// Wiring is keyed by bare function name, not (file, name), because resolving
		// each import specifier back to a service file would mean half a module
		// resolver. That shortcut is only sound while names are globally unique: two
		// files both exporting `list`, one MCP-only and one REST-only, would be
		// conflated and read as "wired on both surfaces" — a false negative that
		// hides exactly the drift this file exists to catch. Fail loudly here instead.
		const byName = new Map<string, string[]>();
		for (const { fn, key } of serviceFns) {
			byName.set(fn, [...(byName.get(fn) ?? []), key.split(":")[0]]);
		}
		const collisions = [...byName].filter(([, files]) => files.length > 1);
		expect(collisions).toEqual([]);
	});

	describe("catalog vs runtime registry", () => {
		it("agrees on membership and order", () => {
			// Not two set comparisons: the arrays must be identical sequences. tools/list
			// returns the runtime order and the docs table renders the catalog order, so
			// reordering one without the other makes the docs lie about dispatch.
			expect(runtimeToolNames).toEqual(catalogToolNames);
		});

		it("has no duplicate tool names", () => {
			const counts = new Map<string, number>();
			for (const name of runtimeToolNames) counts.set(name, (counts.get(name) ?? 0) + 1);
			const dupes = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
			expect(dupes).toEqual([]);
		});

		it("classifies every tool into exactly one group", () => {
			const byTool = new Map<string, string[]>();
			for (const domain of TOOL_DOMAINS) {
				for (const tool of domain.tools) {
					byTool.set(tool.name, [...(byTool.get(tool.name) ?? []), domain.group]);
				}
			}
			const unclassified = runtimeToolNames.filter((n) => (byTool.get(n) ?? []).length !== 1);
			expect(unclassified).toEqual([]);
			for (const groups of byTool.values()) {
				expect(["Coordination", "Project data"]).toContain(groups[0]);
			}
		});

		it("gives every tool a description and an object inputSchema", () => {
			const bad = coreMCPTools
				.filter(
					(t) =>
						!t.description?.trim() ||
						(t.inputSchema as { type?: string } | undefined)?.type !== "object"
				)
				.map((t) => t.name);
			expect(bad).toEqual([]);
		});
	});

	describe("service functions vs both surfaces", () => {
		it("exposes every MCP-wired operation over REST too", () => {
			const gaps = serviceFns
				.filter((s) => s.onMcp && !s.onRest && !(s.key in MCP_ONLY))
				.map((s) => s.key);
			expect(gaps).toEqual([]);
		});

		it("exposes every REST-wired operation as an MCP tool too", () => {
			const gaps = serviceFns
				.filter((s) => s.onRest && !s.onMcp && !(s.key in REST_ONLY))
				.map((s) => s.key);
			expect(gaps).toEqual([]);
		});

		it("names every MCP-wired operation's tool after its service function", () => {
			const mismatched = serviceFns
				.filter((s) => s.onMcp)
				.filter((s) => {
					const expected = TOOL_NAME_ALIASES[s.key] ?? snakeCase(s.fn);
					return !catalogToolNames.includes(expected);
				})
				.map((s) => `${s.key} -> ${TOOL_NAME_ALIASES[s.key] ?? snakeCase(s.fn)}`);
			expect(mismatched).toEqual([]);
		});
	});

	describe("the exception lists stay honest", () => {
		const keys = new Set(serviceFns.map((s) => s.key));

		it("names only service functions that still exist", () => {
			const stale = [
				...Object.keys(MCP_ONLY),
				...Object.keys(REST_ONLY),
				...Object.keys(TOOL_NAME_ALIASES),
			].filter((k) => !keys.has(k));
			expect(stale).toEqual([]);
		});

		it("drops entries whose gap has been closed", () => {
			const byKey = new Map(serviceFns.map((s) => [s.key, s]));
			const fixed = [
				...Object.keys(MCP_ONLY).filter((k) => byKey.get(k)?.onRest),
				...Object.keys(REST_ONLY).filter((k) => byKey.get(k)?.onMcp),
			];
			expect(fixed).toEqual([]);
		});

		it("states a reason for every entry", () => {
			const empty = [...Object.entries(MCP_ONLY), ...Object.entries(REST_ONLY)]
				.filter(([, reason]) => reason.trim().length < 10)
				.map(([k]) => k);
			expect(empty).toEqual([]);
		});

		it("aliases only names that differ from the derived one", () => {
			const redundant = Object.entries(TOOL_NAME_ALIASES)
				.filter(([key, alias]) => snakeCase(key.split(":")[1]) === alias)
				.map(([k]) => k);
			expect(redundant).toEqual([]);
		});
	});
});
