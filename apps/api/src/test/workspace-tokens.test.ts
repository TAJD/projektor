// PROJ-917: workspace tokens (POST/DELETE /api/workspaces/:slug/tokens) are minted and
// revoked only from an interactive human session — the same rule PROJ-903 applied to
// personal access tokens. A pk_ token (even an owner's, with `*` scopes) and an OAuth
// grant are refused; see oauth.test.ts for the OAuth-grant case, which needs that
// file's consent-flow helpers.
//
// In tests the human session is the dev bypass: ENVIRONMENT=development +
// DEV_USER_EMAIL, no Authorization header.

import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedFixture, seedUserToken } from "./helpers";

async function asHuman<T>(email: string, fn: () => Promise<T>): Promise<T> {
	const prev = env.DEV_USER_EMAIL;
	env.DEV_USER_EMAIL = email;
	try {
		return await fn();
	} finally {
		env.DEV_USER_EMAIL = prev;
	}
}

function humanHeaders(slug: string) {
	return { "X-Workspace-Slug": slug, "Content-Type": "application/json" };
}

function mintAsHuman(email: string, slug: string, body: string) {
	return asHuman(email, () =>
		SELF.fetch(`http://localhost/api/workspaces/${slug}/tokens`, {
			method: "POST",
			headers: humanHeaders(slug),
			body,
		})
	);
}

async function tokenRow(name: string) {
	return env.DB.prepare("SELECT id FROM api_tokens WHERE name = ?").bind(name).first<{
		id: string;
	}>();
}

describe("PROJ-917: workspace tokens require a human session", () => {
	it("an owner's pk_ token cannot mint a workspace token", async () => {
		const f = await seedFixture({ role: "owner" });
		const res = await SELF.fetch(`http://localhost/api/workspaces/${f.workspace.slug}/tokens`, {
			method: "POST",
			headers: authHeaders(f.token, f.workspace.slug),
			body: JSON.stringify({ name: "sibling", scopes: ["*"] }),
		});
		expect(res.status).toBe(403);
		expect(((await res.json()) as { error: string }).error).toMatch(/signed-in browser session/);
		expect(await tokenRow("sibling")).toBeNull();
	});

	it("a user-scoped PAT cannot mint a workspace token either", async () => {
		const f = await seedFixture({ role: "owner" });
		const pat = await seedUserToken(f.user.id);
		const res = await SELF.fetch(`http://localhost/api/workspaces/${f.workspace.slug}/tokens`, {
			method: "POST",
			headers: authHeaders(pat, f.workspace.slug),
			body: JSON.stringify({ name: "via-pat", scopes: ["read"] }),
		});
		expect(res.status).toBe(403);
		expect(await tokenRow("via-pat")).toBeNull();
	});

	it("a human session mints; a pk_ token cannot revoke; the human can", async () => {
		const f = await seedFixture({ role: "owner" });
		const slug = f.workspace.slug;
		const mint = await mintAsHuman(
			f.user.email,
			slug,
			JSON.stringify({ name: "human-minted", scopes: ["read"] })
		);
		expect(mint.status).toBe(201);
		const { id, token } = (await mint.json()) as { id: string; token: string };
		expect(token).toMatch(/^pk_/);

		const byToken = await SELF.fetch(`http://localhost/api/workspaces/${slug}/tokens/${id}`, {
			method: "DELETE",
			headers: authHeaders(f.token, slug),
		});
		expect(byToken.status).toBe(403);
		expect(await tokenRow("human-minted")).not.toBeNull();

		const byHuman = await asHuman(f.user.email, () =>
			SELF.fetch(`http://localhost/api/workspaces/${slug}/tokens/${id}`, {
				method: "DELETE",
				headers: humanHeaders(slug),
			})
		);
		expect(byHuman.status).toBe(200);
		expect(await tokenRow("human-minted")).toBeNull();
	});

	it("a human session still gets role checks: a member is refused", async () => {
		const f = await seedFixture({ role: "member" });
		const res = await mintAsHuman(
			f.user.email,
			f.workspace.slug,
			JSON.stringify({ name: "member-minted", scopes: ["read"] })
		);
		expect(res.status).toBe(403);
		expect(await tokenRow("member-minted")).toBeNull();
	});

	it("malformed JSON from a human session is a 400, not a 500", async () => {
		const f = await seedFixture({ role: "owner" });
		const res = await mintAsHuman(f.user.email, f.workspace.slug, "{bad json");
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toMatch(/valid JSON/);
	});

	it("listing stays available to an admin's pk_ token (no secrets returned)", async () => {
		const f = await seedFixture({ role: "owner" });
		const res = await SELF.fetch(`http://localhost/api/workspaces/${f.workspace.slug}/tokens`, {
			headers: authHeaders(f.token, f.workspace.slug),
		});
		expect(res.status).toBe(200);
	});
});
