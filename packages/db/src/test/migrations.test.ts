import { describe, expect, it } from "vitest";
import { loadMigrations, migratedDb } from "./helpers";

describe("migrations", () => {
	it("apply cleanly in order against a fresh database", () => {
		expect(() => migratedDb()).not.toThrow();
	});

	it("discovers at least one migration file", () => {
		expect(loadMigrations().length).toBeGreaterThan(0);
	});

	it("creates the core tables", () => {
		const db = migratedDb();
		const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
			name: string;
		}[];
		const tables = rows.map((r) => r.name);
		expect(tables).toEqual(
			expect.arrayContaining(["workspaces", "users", "workspace_members", "projects", "issues"])
		);
	});
});

describe("schema constraints", () => {
	it("rejects a NULL in a NOT NULL column", () => {
		const db = migratedDb();
		expect(() =>
			db
				.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
				.run("w1", null, "acme", 0)
		).toThrow();
	});

	it("rejects a duplicate value in a UNIQUE column (workspaces.slug)", () => {
		const db = migratedDb();
		db.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)").run(
			"w1",
			"Acme",
			"acme",
			0
		);
		expect(() =>
			db
				.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)")
				.run("w2", "Acme Two", "acme", 0)
		).toThrow();
	});

	it("rejects a duplicate value in a UNIQUE column (users.email)", () => {
		const db = migratedDb();
		db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
			"u1",
			"a@example.com",
			"A",
			0
		);
		expect(() =>
			db
				.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)")
				.run("u2", "a@example.com", "A2", 0)
		).toThrow();
	});

	it("rejects a foreign key violation (workspace_members.workspace_id -> workspaces)", () => {
		const db = migratedDb();
		db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
			"u1",
			"a@example.com",
			"A",
			0
		);
		expect(() =>
			db
				.prepare(
					"INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)"
				)
				.run("no-such-workspace", "u1", "member", 0)
		).toThrow();
	});

	it("cascades workspace deletion to its members", () => {
		const db = migratedDb();
		db.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)").run(
			"w1",
			"Acme",
			"acme",
			0
		);
		db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
			"u1",
			"a@example.com",
			"A",
			0
		);
		db.prepare(
			"INSERT INTO workspace_members (workspace_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)"
		).run("w1", "u1", "member", 0);

		db.prepare("DELETE FROM workspaces WHERE id = ?").run("w1");

		const rows = db.prepare("SELECT * FROM workspace_members WHERE workspace_id = ?").all("w1");
		expect(rows).toHaveLength(0);
	});

	it("rejects a duplicate issue number within the same project (composite UNIQUE index)", () => {
		const db = migratedDb();
		db.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)").run(
			"w1",
			"Acme",
			"acme",
			0
		);
		db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, ?)").run(
			"u1",
			"a@example.com",
			"A",
			0
		);
		db.prepare(
			"INSERT INTO projects (id, workspace_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
		).run("p1", "w1", "Acme Project", "ACME", 0, 0);
		db.prepare(
			`INSERT INTO issues (id, workspace_id, project_id, number, title, created_by_id, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
		).run("i1", "w1", "p1", 1, "First issue", "u1", 0, 0);

		expect(() =>
			db
				.prepare(
					`INSERT INTO issues (id, workspace_id, project_id, number, title, created_by_id, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run("i2", "w1", "p1", 1, "Duplicate number", "u1", 0, 0)
		).toThrow();
	});
});
