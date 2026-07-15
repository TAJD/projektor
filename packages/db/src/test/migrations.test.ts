import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadMigrations, migratedDb } from "./helpers";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../migrations");

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

	// PROJ-376: the 0035 backfill must not violate its own unique index when two
	// pre-existing projects in the same workspace slugify to the same value —
	// this previously aborted the whole migration on real data (opus review finding).
	it("0035_project_slug backfill dedupes colliding slugs instead of aborting", () => {
		const migrationFiles = readdirSync(MIGRATIONS_DIR)
			.filter((f) => f.endsWith(".sql"))
			.sort();
		const preSlugFiles = migrationFiles.filter((f) => f < "0035");
		const slugFile = migrationFiles.find((f) => f.startsWith("0035"));
		expect(slugFile).toBeDefined();

		const db = new DatabaseSync(":memory:");
		db.exec("PRAGMA foreign_keys = ON;");
		const splitStatements = (sql: string) =>
			sql
				.replace(/--[^\n]*/g, "")
				.split(";")
				.map((s) => s.trim())
				.filter((s) => s.length > 0);
		for (const file of preSlugFiles) {
			const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
			for (const stmt of splitStatements(sql)) {
				if (/\bfts5\b/i.test(stmt) || /\bissues_fts\b/i.test(stmt)) continue;
				db.exec(stmt);
			}
		}

		db.prepare("INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)").run(
			"w1",
			"Acme",
			"acme",
			0
		);
		// Two projects that slugify to the same base value ("start-line").
		db.prepare(
			"INSERT INTO projects (id, workspace_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
		).run("p1", "w1", "Start Line", "SL", 0, 0);
		db.prepare(
			"INSERT INTO projects (id, workspace_id, name, key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
		).run("p2", "w1", "Start_Line", "SL2", 1, 1);

		const slugSql = readFileSync(join(MIGRATIONS_DIR, slugFile!), "utf8");
		expect(() => {
			for (const stmt of splitStatements(slugSql)) db.exec(stmt);
		}).not.toThrow();

		const rows = db.prepare("SELECT id, slug FROM projects ORDER BY id").all() as {
			id: string;
			slug: string;
		}[];
		const slugs = rows.map((r) => r.slug);
		expect(new Set(slugs).size).toBe(2);
		expect(slugs).toContain("start-line");
		expect(slugs).toContain("start-line-2");
	});
});
