import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { subdomainRoutingEnabled } from "../middleware/workspace";
import { seedFixture } from "./helpers";

describe("subdomainRoutingEnabled", () => {
	it.each(["true", "1", "yes", "TRUE", "Yes", " true ", "1 "])("accepts %j", (v) => {
		expect(subdomainRoutingEnabled(v)).toBe(true);
	});

	it.each([undefined, "", "false", "0", "no", "on"])("rejects %j", (v) => {
		expect(subdomainRoutingEnabled(v)).toBe(false);
	});
});

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

	// Uses a REST route: PROJ-348 gives the /mcp/<id> route a path-UUID fallback, so
	// the "no header → 400" contract now only holds for non-MCP routes.
	it("flag off + no header: clean 400 naming the missing header, Host subdomain is ignored", async () => {
		const fixture = await seedFixture();
		const res = await SELF.fetch("http://localhost/api/task-types", {
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				Host: `${fixture.workspace.slug}.example.com`,
			},
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

	it('flag "1" (truthy, non-"true") + no header + matching Host subdomain resolves', async () => {
		const fixture = await seedFixture();
		env.WORKSPACE_SUBDOMAIN_ROUTING = "1";
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

	it("flag off + no header + a resolvable subdomain warns before the 400", async () => {
		const fixture = await seedFixture();
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const res = await SELF.fetch("http://localhost/api/task-types", {
			headers: {
				Authorization: `Bearer ${fixture.token}`,
				Host: `${fixture.workspace.slug}.example.com`,
			},
		});
		expect(res.status).toBe(400);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(fixture.workspace.slug));
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("WORKSPACE_SUBDOMAIN_ROUTING"));
		warnSpy.mockRestore();
	});
});
