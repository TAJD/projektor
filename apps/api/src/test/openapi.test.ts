import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { app } from "../index";
import { ALL_OPERATIONS, buildOpenApi, buildSearchIndex } from "../openapi";
import { coreMCPTools } from "../routes/mcp";
import { authHeaders, seedProjectFixture } from "./helpers";

const SPA_FALLBACK = `GET /${"*"}`;

const HAND_WRITTEN: Record<string, string> = {
	"GET /health": "infrastructure: liveness probe",
	"GET /api/health": "infrastructure: liveness probe",
	"GET /api/config/brand": "infrastructure: public branding for the login page, before auth",
	"GET /bootstrap": "infrastructure: browser session bootstrap",
	"GET /wiki": "infrastructure: server-rendered wiki shell",
	[SPA_FALLBACK]: "infrastructure: SPA and SSR fallback",
	"GET /api/realtime": "infrastructure: WebSocket upgrade",
	"GET /api/workspaces/:slug/realtime": "infrastructure: WebSocket upgrade",
	"POST /mcp/:workspaceId": "infrastructure: the MCP endpoint itself",
	"GET /.well-known/oauth-authorization-server": "infrastructure: OAuth metadata",
	"GET /.well-known/oauth-protected-resource/mcp/:workspaceId": "infrastructure: OAuth metadata",
	"GET /oauth/authorize": "infrastructure: OAuth consent page",
	"POST /oauth/authorize": "infrastructure: OAuth consent decision",
	"GET /auth/login": "infrastructure: browser login redirect",
	"GET /auth/me": "infrastructure: browser session identity",
	"GET /api/openapi.json": "infrastructure: this spec",
	"POST /auth/tokens": "tokens: personal access tokens are minted in the UI",
	"DELETE /auth/tokens/:id": "tokens: revoking a personal access token is a UI action",
	"GET /api/workspaces/:slug/tokens": "tokens: token inventory is a human audit view",
	"POST /api/workspaces/:slug/tokens": "tokens: workspace tokens are minted in the UI",
	"DELETE /api/workspaces/:slug/tokens/:tokenId": "tokens: revoking one is a human action",
	"GET /api/workspaces/:slug/connectors": "connectors: an agent must not enumerate credentials",
	"DELETE /api/workspaces/:slug/connectors/:grantId": "connectors: revoking is a browser action",
	"GET /api/workspaces/:slug/mcp-info": "mcp-info: connection instructions for a human",
	"GET /api/workspaces/:slug/brand/logo": "logo: streams bytes",
	"POST /api/workspaces/:slug/brand/logo": "logo: multipart upload",
	"DELETE /api/workspaces/:slug/brand/logo": "logo: managed with the upload",
	"POST /api/files": "file bytes: multipart upload",
	"GET /api/files/:id": "file bytes: streams the file",
	"GET /api/link-preview/image": "file bytes: streams a proxied preview image",
	"GET /api/wiki/export": "wiki export: zip download",
	"GET /api/share/:token": "share: anonymous read of a shared issue",
	"GET /api/share/:token/logo": "share: anonymous logo for a shared issue",
	"POST /api/issues/:id/share": "share: public links are issued by a human",
	"DELETE /api/issues/:id/share": "share: revoking a public link is a human action",
	"POST /api/feedback/submit": "public feedback: ingest keyed by a source token",
	"OPTIONS /api/feedback/submit": "public feedback: CORS preflight",
	"GET /api/projects": "browser: cross-workspace project list for the workspace switcher",
	"GET /api/issues/:id/leases": "issue leases: per-issue alias of list_issue_leases",
	"GET /api/projects/:id/feedback/summary": "browser: human triage dashboard (PROJ-634)",
	"POST /api/projects/:id/feedback/bulk-mark-reviewed": "browser: human triage (PROJ-634)",
	"POST /api/projects/:id/feedback/bulk-convert-to-issue": "browser: human triage (PROJ-634)",
};

type SpecOperation = {
	operationId: string;
	description: string;
	parameters?: Array<{ name?: string; in?: string; required?: boolean; $ref?: string }>;
	requestBody?: { content: { "application/json": { schema: { properties?: object } } } };
};

function specPaths() {
	return buildOpenApi().paths as Record<string, Record<string, SpecOperation>>;
}

describe("PROJ-895: OpenAPI spec and search index from the operation registry", () => {
	it("every REST route is a registry operation or on the hand-written allowlist", () => {
		const ops = new Set(ALL_OPERATIONS.map((op) => `${op.method} ${op.path}`));
		const routes = new Set(
			app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`)
		);
		const unlisted = [...routes].filter((r) => !ops.has(r) && !(r in HAND_WRITTEN));
		expect(unlisted, "add an operation, or an allowlist entry with its reason").toEqual([]);
		const stale = Object.keys(HAND_WRITTEN).filter((r) => !routes.has(r));
		expect(stale, "remove allowlist entries for routes that no longer exist").toEqual([]);
		const unrouted = [...ops].filter((r) => !routes.has(r));
		expect(unrouted, "every operation is mounted").toEqual([]);
	});

	it("the registry is every MCP tool, each operation once", () => {
		const ids = ALL_OPERATIONS.map((op) => op.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect([...ids].sort()).toEqual(coreMCPTools.map((t) => t.name).sort());
	});

	it("each operation appears once in the spec, with its path parameters declared", () => {
		const seen: string[] = [];
		for (const [path, methods] of Object.entries(specPaths())) {
			const placeholders = [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
			for (const op of Object.values(methods)) {
				seen.push(op.operationId);
				const declared = (op.parameters ?? []).filter((p) => p.in === "path");
				expect(declared.map((p) => p.name).sort(), op.operationId).toEqual(placeholders);
				expect(declared.every((p) => p.required)).toBe(true);
			}
		}
		expect(seen.sort()).toEqual(ALL_OPERATIONS.map((op) => op.id).sort());
	});

	it("query parameters for reads, a JSON body for writes, refine messages in the description", () => {
		const paths = specPaths();
		const workspaceHeader = { $ref: "#/components/parameters/WorkspaceSlug" };
		const getIssue = paths["/api/issues/{id}"].get;
		expect(getIssue.parameters?.some((p) => p.in === "query")).toBe(true);
		expect(getIssue.parameters).toContainEqual(workspaceHeader);

		const update = paths["/api/issues/{id}"].patch;
		const body = update.requestBody?.content["application/json"].schema.properties;
		expect(body).toHaveProperty("title");
		expect(body).not.toHaveProperty("id");
		expect(update.description).toContain("Constraints:");

		expect(paths["/api/wiki/{slug}"].get.parameters).toContainEqual(workspaceHeader);
		expect(paths["/api/workspaces/{slug}/projects"].get.parameters ?? []).not.toContainEqual(
			workspaceHeader
		);
	});

	it("the search index stays compact", () => {
		const index = buildSearchIndex();
		const count = Object.values(index.domains).reduce((n, d) => n + d.ops.length, 0);
		expect(count).toBe(ALL_OPERATIONS.length);
		expect(JSON.stringify(index).length).toBeLessThan(24 * 1024);
	});

	it("GET /api/openapi.json needs auth and serves the generated spec", async () => {
		const anon = await SELF.fetch("http://localhost/api/openapi.json");
		expect(anon.status).toBe(401);

		const { token, slug } = await seedProjectFixture();
		const res = await SELF.fetch("http://localhost/api/openapi.json", {
			headers: authHeaders(token, slug),
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(JSON.parse(JSON.stringify(buildOpenApi())));
	});
});
