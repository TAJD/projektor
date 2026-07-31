import type { HonoEnv } from "@projektor/types";
import type { Context } from "hono";
import { authMiddleware } from "../middleware/auth";
import { subdomainRoutingEnabled } from "../middleware/workspace";
import { ctxFromHono } from "../services/types";
import { getWikiPage } from "../services/wiki";

// PROJ-487 fix-up: server-side redirect + metadata injection for the /wiki catch-all
// need a workspace-scoped ServiceCtx, but a plain top-level browser navigation carries
// none of the signals workspaceMiddleware requires (no X-Workspace-Slug header, and
// subdomain routing is opt-in) — so this deliberately does NOT reuse workspaceMiddleware
// verbatim. Instead it mirrors its resolution order and adds DEFAULT_WORKSPACE_SLUG as a
// final fallback (the common case for a single-tenant deployment, matching the
// PUBLIC_READ_ONLY/provisioning convention elsewhere in this file), and never writes an
// error response itself — callers treat a null return as "fall back to the plain shell",
// not an error, since this is a best-effort enhancement over the client-side behavior
// that already exists.
async function resolveWikiWorkspaceContext(
	c: Context<HonoEnv>
): Promise<{ id: string; name: string; slug: string; role: string } | null> {
	const headerSlug = c.req.header("X-Workspace-Slug");
	const routingEnabled = subdomainRoutingEnabled(c.env.WORKSPACE_SUBDOMAIN_ROUTING);
	const subdomainSlug = routingEnabled ? c.req.header("host")?.split(".")[0] : undefined;
	const slug = headerSlug ?? subdomainSlug ?? c.env.DEFAULT_WORKSPACE_SLUG;
	if (!slug) return null;

	const user = c.get("user") as { id: string } | undefined;
	if (!user) return null;

	const row = await c.env.DB.prepare(
		`SELECT w.id, w.name, w.slug, m.role
		 FROM workspaces w
		 LEFT JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = ?
		 WHERE w.slug = ?`
	)
		.bind(user.id, slug)
		.first<{ id: string; name: string; slug: string; role: string | null }>();
	if (!row?.role) return null;

	return { id: row.id, name: row.name, slug: row.slug, role: row.role };
}

export interface WikiSsrPage {
	title: string;
	content: string;
	url: string;
}

// Best-effort: authenticates the request and resolves a workspace-scoped wiki page for
// SSR purposes (redirect target / injected metadata). Returns null on ANY failure to
// authenticate, resolve a workspace, or find/view the page — callers must fall back to
// serving the plain static shell rather than erroring the page load, and must never let
// this leak page existence/content to an unauthenticated caller.
export async function resolveWikiPageForSsr(
	c: Context<HonoEnv>,
	slugOrId: string
): Promise<WikiSsrPage | null> {
	let authenticated = false;
	const authResponse = await authMiddleware(c, async () => {
		authenticated = true;
	});
	if (authResponse || !authenticated) return null;

	const workspace = await resolveWikiWorkspaceContext(c);
	if (!workspace) return null;
	c.set("workspace", { id: workspace.id, name: workspace.name, slug: workspace.slug });
	c.set("role", workspace.role);

	try {
		const page = await getWikiPage(ctxFromHono(c), slugOrId);
		return { title: page.title, content: page.content, url: page.url };
	} catch {
		// NotFoundError / ForbiddenError / anything else — no metadata to inject, no
		// redirect target; the plain shell (or a client-side 404) still works.
		return null;
	}
}

function plainTextExcerpt(markdown: string, maxLen = 200): string {
	const plain = markdown
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[\[([^\]|]*)(\|[^\]]*)?\]\]/g, "$1")
		.replace(/[#>*_`~-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return plain.length > maxLen ? `${plain.slice(0, maxLen - 1)}…` : plain;
}

class AttrSetter {
	constructor(
		private attr: string,
		private value: string
	) {}
	element(el: Element) {
		el.setAttribute(this.attr, this.value);
	}
}

class TextSetter {
	constructor(private value: string) {}
	element(el: Element) {
		el.setInnerContent(this.value);
	}
}

// Rewrites <title> and og:title/og:description/og:url on the static wiki shell response
// with real values for a resolved page. Never throws — a rewrite failure just means the
// caller serves the unmodified shell.
export function injectWikiMetadata(
	response: Response,
	page: WikiSsrPage,
	pageUrl: string
): Response {
	const description = plainTextExcerpt(page.content);
	return new HTMLRewriter()
		.on("title", new TextSetter(`${page.title} — Projektor Wiki`))
		.on('meta[property="og:title"]', new AttrSetter("content", page.title))
		.on('meta[property="og:description"]', new AttrSetter("content", description))
		.on('meta[property="og:url"]', new AttrSetter("content", pageUrl))
		.transform(response);
}
