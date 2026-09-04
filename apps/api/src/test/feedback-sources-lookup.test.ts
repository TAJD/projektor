import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedProjectFixture } from "./helpers";

async function createSource(f: Readonly<{ projectId: string; token: string; slug: string }>) {
	const res = await SELF.fetch(`http://localhost/api/projects/${f.projectId}/feedback-sources`, {
		method: "POST",
		headers: authHeaders(f.token, f.slug),
		body: JSON.stringify({ name: "Onboarding survey" }),
	});
	const { id } = (await res.json()) as { id: string };
	return id;
}

describe("GET /api/feedback-sources/:sourceId (PROJ-724)", () => {
	it("returns the source including projectId", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const sourceId = await createSource(f);

		const res = await SELF.fetch(`http://localhost/api/feedback-sources/${sourceId}`, {
			headers: authHeaders(f.token, f.slug),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; projectId: string; name: string };
		expect(body.id).toBe(sourceId);
		expect(body.projectId).toBe(f.projectId);
		expect(body.name).toBe("Onboarding survey");
	});

	it("404s for an unknown sourceId", async () => {
		const f = await seedProjectFixture({ role: "owner" });
		const res = await SELF.fetch(`http://localhost/api/feedback-sources/${crypto.randomUUID()}`, {
			headers: authHeaders(f.token, f.slug),
		});
		expect(res.status).toBe(404);
	});

	it("404s (not leaks) a source from another workspace", async () => {
		const owner = await seedProjectFixture({ role: "owner" });
		const sourceId = await createSource(owner);

		const outsider = await seedProjectFixture({ role: "owner" });
		const res = await SELF.fetch(`http://localhost/api/feedback-sources/${sourceId}`, {
			headers: authHeaders(outsider.token, outsider.slug),
		});
		expect(res.status).toBe(404);
	});
});
