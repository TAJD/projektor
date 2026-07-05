import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { seedFixture } from "./helpers";

// PROJ-267 (epic PROJ-261, C2): Host-header subdomain routing is opt-in via
// WORKSPACE_SUBDOMAIN_ROUTING and off by default.
describe("workspace subdomain routing (WORKSPACE_SUBDOMAIN_ROUTING)", () => {
	beforeEach(() => {
		env.WORKSPACE_SUBDOMAIN_ROUTING = undefined;
	});

	it("X-Workspace-Slug header works regardless of the flag", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch(`http://localhost/mcp/${fixture.workspace.id}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				"X-Workspace-Slug": fixture.workspace.slug,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		expect(res.status).toBe(200);
	});

	it("flag off + no header: clean 400 naming the missing header, Host subdomain is ignored", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch(`http://localhost/mcp/${fixture.workspace.id}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				Host: `${fixture.workspace.slug}.example.com`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("X-Workspace-Slug");
	});

	it("flag on + no header + matching Host subdomain resolves the workspace", async () => {
		const fixture = await seedFixture();
		env.WORKSPACE_SUBDOMAIN_ROUTING = "true";
		const res = await SELF.fetch(`http://localhost/mcp/${fixture.workspace.id}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				Host: `${fixture.workspace.slug}.example.com`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
		});
		expect(res.status).toBe(200);
	});
});
