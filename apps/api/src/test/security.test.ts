import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { seedFixture, seedMember } from "./helpers";

describe("PROJ-16: API token workspace scope", () => {
	it("rejects a token for workspace A used against workspace B, even when the user is a member of both", async () => {
		const wsA = await seedFixture();
		const wsB = await seedFixture();
		// Make wsA's user a member of wsB so the only rejection reason is the token's workspace scope
		await seedMember(wsB.workspace.id, wsA.user.id);

		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: {
				Authorization: `Bearer ${wsA.token}`,
				"X-Workspace-Slug": wsB.workspace.slug,
			},
		});
		expect(res.status).toBe(403);
	});

	it("allows a valid token used against its own workspace", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/api/issues", {
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"X-Workspace-Slug": fixture.workspace.slug,
			},
		});
		expect(res.status).toBe(200);
	});
});

// wrangler.test.toml sets ENVIRONMENT=development and BOOTSTRAP_SECRET=test-bootstrap-secret-...
// Tests cover the secret-validation path; the "non-development env → 403" invariant is
// enforced by the `!== 'development'` guard in index.ts (fail-closed, not opt-in-to-block).
describe("PROJ-18: /bootstrap fail-closed", () => {
	const CORRECT_SECRET = "test-bootstrap-secret-do-not-use-in-production";

	it("returns 403 when no setup secret is provided", async () => {
		const res = await SELF.fetch("http://localhost/bootstrap");
		expect(res.status).toBe(403);
	});

	it("returns 403 when a wrong secret is provided via header", async () => {
		const res = await SELF.fetch("http://localhost/bootstrap", {
			headers: { "X-Bootstrap-Secret": "not-the-right-secret" },
		});
		expect(res.status).toBe(403);
	});

	it("returns 403 when a wrong secret is provided via query param", async () => {
		const res = await SELF.fetch("http://localhost/bootstrap?setup_secret=wrong");
		expect(res.status).toBe(403);
	});

	it("returns 200 and mints a token when correct secret is in X-Bootstrap-Secret header", async () => {
		const res = await SELF.fetch("http://localhost/bootstrap", {
			headers: { "X-Bootstrap-Secret": CORRECT_SECRET },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			token: string;
			workspace: { slug: string };
			user: { email: string };
		};
		expect(body.token).toMatch(/^pk_/);
		expect(body.workspace.slug).toBe("projektor");
	});

	it("returns 200 when correct secret is provided via setup_secret query param", async () => {
		const res = await SELF.fetch(`http://localhost/bootstrap?setup_secret=${CORRECT_SECRET}`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { token: string };
		expect(body.token).toMatch(/^pk_/);
	});
});
