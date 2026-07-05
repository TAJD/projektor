import { env } from "cloudflare:test";
import type { Env } from "@projektor/types";
import { describe, expect, it } from "vitest";
import { provisionUserOnLogin } from "../services/provisioning";
import { seedMember, seedUser, seedWorkspace } from "./helpers";

// provisionUserOnLogin reads its config from the Env it's handed, so each test builds an
// Env by spreading the test bindings and overriding the provisioning vars. Unique slugs +
// emails per test keep the shared D1 from leaking state across cases.
function envWith(overrides: Partial<Env>): Env {
	return { ...(env as unknown as Env), ...overrides };
}

async function memberRole(workspaceId: string, userId: string) {
	const row = await env.DB.prepare(
		"SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?"
	)
		.bind(workspaceId, userId)
		.first<{ role: string }>();
	return row?.role ?? null;
}

// cofferdam-ignore: Readability.MaxFunctionLength: full integration test suite in one describe block, normal test style
describe("login provisioning", () => {
	it("first admin login creates the default workspace and makes them owner", async () => {
		const slug = "prov-admin-create";
		const admin = await seedUser("admin-create@example.com");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "admin-create@example.com",
				DEFAULT_WORKSPACE_SLUG: slug,
				AUTO_JOIN_ROLE: "viewer",
			}),
			admin
		);

		const ws = await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?")
			.bind(slug)
			.first<{ id: string }>();
		expect(ws).not.toBeNull();
		expect(await memberRole(ws!.id, admin.id)).toBe("owner");
	});

	it("non-admin auto-joins an existing workspace as viewer", async () => {
		const slug = "prov-viewer";
		const ws = await seedWorkspace(slug);
		const user = await seedUser("viewer-join@example.com");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "someone-else@example.com",
				DEFAULT_WORKSPACE_SLUG: slug,
				AUTO_JOIN_ROLE: "viewer",
			}),
			user
		);

		expect(await memberRole(ws.id, user.id)).toBe("viewer");
	});

	it("non-admin logging in before any workspace exists gets nothing (no workspace, no membership)", async () => {
		const slug = "prov-not-yet";
		const user = await seedUser("early-bird@example.com");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "boss@example.com",
				DEFAULT_WORKSPACE_SLUG: slug,
				AUTO_JOIN_ROLE: "viewer",
			}),
			user
		);

		const ws = await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?").bind(slug).first();
		expect(ws).toBeNull();
	});

	it("AUTO_JOIN_ROLE=none leaves non-admins without a membership (invite-only)", async () => {
		const slug = "prov-invite-only";
		const ws = await seedWorkspace(slug);
		const user = await seedUser("no-autojoin@example.com");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "boss@example.com",
				DEFAULT_WORKSPACE_SLUG: slug,
				AUTO_JOIN_ROLE: "none",
			}),
			user
		);

		expect(await memberRole(ws.id, user.id)).toBeNull();
	});

	it("PROJ-193: defaults to invite-only (no auto-join) when AUTO_JOIN_ROLE is unset", async () => {
		const slug = "prov-default-invite-only";
		const ws = await seedWorkspace(slug);
		const user = await seedUser("unset-autojoin@example.com");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "boss@example.com",
				DEFAULT_WORKSPACE_SLUG: slug,
				AUTO_JOIN_ROLE: undefined,
			}),
			user
		);

		expect(await memberRole(ws.id, user.id)).toBeNull();
	});

	it("promotes an existing lower-role member to owner when they are now an admin", async () => {
		const slug = "prov-promote";
		const ws = await seedWorkspace(slug);
		const user = await seedUser("promote-me@example.com");
		await seedMember(ws.id, user.id, "viewer");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "promote-me@example.com",
				DEFAULT_WORKSPACE_SLUG: slug,
				AUTO_JOIN_ROLE: "viewer",
			}),
			user
		);

		expect(await memberRole(ws.id, user.id)).toBe("owner");
	});

	it("confines a non-admin to the workspace mapped to their email domain (not the default)", async () => {
		const mappedWs = await seedWorkspace("prov-mapped");
		const defaultWs = await seedWorkspace("prov-default-1");
		const user = await seedUser("colleague@example.com");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "boss@example.com",
				DEFAULT_WORKSPACE_SLUG: "prov-default-1",
				AUTO_JOIN_ROLE: "viewer",
				WORKSPACE_DOMAIN_MAP: '{"example.com":{"slug":"prov-mapped","role":"member"}}',
			}),
			user
		);

		expect(await memberRole(mappedWs.id, user.id)).toBe("member");
		// Confinement: they must NOT have been auto-joined to the default workspace.
		expect(await memberRole(defaultWs.id, user.id)).toBeNull();
	});

	it("an admin in a mapped domain owns default + mapped workspace (ADMIN_EMAILS beats confinement)", async () => {
		const mappedWs = await seedWorkspace("prov-mapped-2");
		const defaultWs = await seedWorkspace("prov-default-2");
		const admin = await seedUser("tajd@example.com");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "tajd@example.com",
				DEFAULT_WORKSPACE_SLUG: "prov-default-2",
				AUTO_JOIN_ROLE: "viewer",
				WORKSPACE_DOMAIN_MAP: '{"example.com":{"slug":"prov-mapped-2","role":"member"}}',
			}),
			admin
		);

		// The domain rule never confines an admin; admins own every workspace, mapped or not.
		expect(await memberRole(defaultWs.id, admin.id)).toBe("owner");
		expect(await memberRole(mappedWs.id, admin.id)).toBe("owner");
	});

	it("an admin is made owner of every existing workspace on login, not just the default", async () => {
		const defaultWs = await seedWorkspace("prov-own-all-default");
		const wsA = await seedWorkspace("prov-own-all-a");
		const wsB = await seedWorkspace("prov-own-all-b");
		const admin = await seedUser("owns-everything@example.com");
		// Pre-existing low role in one of them must be promoted to owner, not left as-is.
		await seedMember(wsA.id, admin.id, "viewer");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "owns-everything@example.com",
				DEFAULT_WORKSPACE_SLUG: "prov-own-all-default",
				AUTO_JOIN_ROLE: "viewer",
			}),
			admin
		);

		expect(await memberRole(defaultWs.id, admin.id)).toBe("owner");
		expect(await memberRole(wsA.id, admin.id)).toBe("owner");
		expect(await memberRole(wsB.id, admin.id)).toBe("owner");
	});

	it("matches ADMIN_EMAILS case-insensitively", async () => {
		const slug = "prov-case";
		const user = await seedUser("mixed-case@example.com");

		await provisionUserOnLogin(
			envWith({
				ADMIN_EMAILS: "Mixed-Case@Example.com",
				DEFAULT_WORKSPACE_SLUG: slug,
				AUTO_JOIN_ROLE: "viewer",
			}),
			user
		);

		const ws = await env.DB.prepare("SELECT id FROM workspaces WHERE slug = ?")
			.bind(slug)
			.first<{ id: string }>();
		expect(ws).not.toBeNull();
		expect(await memberRole(ws!.id, user.id)).toBe("owner");
	});
});
