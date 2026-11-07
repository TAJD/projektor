import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { authHeaders, seedFixture } from "./helpers";

type Fixture = Awaited<ReturnType<typeof seedFixture>>;

async function createPage(f: Fixture, title: string, content: string) {
	const res = await SELF.fetch("http://localhost/api/wiki", {
		method: "POST",
		headers: authHeaders(f.token, f.workspace.slug),
		body: JSON.stringify({ title, content }),
	});
	return (await res.json()) as { id: string };
}

async function search(f: Fixture, q: string) {
	const res = await SELF.fetch(`http://localhost/api/wiki/search?q=${encodeURIComponent(q)}`, {
		headers: authHeaders(f.token, f.workspace.slug),
	});
	return (await res.json()) as Array<{ id: string; excerpt: string }>;
}

describe("wiki search is scoped to the workspace inside MATCH (PROJ-926)", () => {
	it("returns only the caller's pages and keeps highlighted excerpts", async () => {
		const a = await seedFixture({ role: "admin" });
		const b = await seedFixture({ role: "admin" });
		const pa = await createPage(a, "Zebrafinch handbook", "notes about zebrafinch care");
		const pb = await createPage(b, "Zebrafinch handbook", "zebrafinch zebrafinch zebrafinch");

		const resA = await search(a, "zebrafinch");
		expect(resA.map((r) => r.id)).toEqual([pa.id]);
		expect(resA[0]?.excerpt.toLowerCase()).toContain("**zebrafinch**");
		const resB = await search(b, "zebrafinch");
		expect(resB.map((r) => r.id)).toEqual([pb.id]);
	});

	it("does not return another workspace's page even when the query names its id", async () => {
		const a = await seedFixture({ role: "admin" });
		const b = await seedFixture({ role: "admin" });
		await createPage(b, "Quokka secrets", "quokka");
		expect(await search(a, `quokka ${b.workspace.id}`)).toEqual([]);
		expect(await search(a, "quokka")).toEqual([]);
	});

	it("scoped MATCH only visits the workspace's own FTS rows", async () => {
		const a = await seedFixture({ role: "admin" });
		const b = await seedFixture({ role: "admin" });
		await createPage(a, "Axolotl", "axolotl");
		await createPage(b, "Axolotl", "axolotl");
		const { results } = await env.DB.prepare(
			"SELECT workspace_id FROM wiki_fts WHERE wiki_fts MATCH ?"
		)
			.bind(`workspace_id : "${a.workspace.id}" AND ("axolotl")`)
			.all<{ workspace_id: string }>();
		expect(results.map((r) => r.workspace_id)).toEqual([a.workspace.id]);
	});

	it("migration kept existing rows searchable with their search_rowid link", async () => {
		const a = await seedFixture({ role: "admin" });
		const p = await createPage(a, "Linkcheck page", "linkcheck");
		const row = await env.DB.prepare(
			"SELECT p.search_rowid AS r, f.rowid AS fr FROM wiki_pages p JOIN wiki_fts f ON f.rowid = p.search_rowid WHERE p.id = ?"
		)
			.bind(p.id)
			.first<{ r: number; fr: number }>();
		expect(row?.r).toBe(row?.fr);
	});
});
