import { env, SELF } from "cloudflare:test";
import type { Env } from "@projektor/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHub } from "../realtime/workspace-hub";
import { createIssue } from "../services/issues";
import { broadcastWorkspaceEvent } from "../services/realtime";
import type { ServiceCtx } from "../services/types";
import { authHeaders, seedProjectFixture } from "./helpers";

describe("Realtime WebSockets (Opt-In)", () => {
	let token: string;
	let slug: string;
	let workspaceId: string;
	let userId: string;
	let projectId: string;

	beforeEach(async () => {
		({ token, slug, workspaceId, userId, projectId } = await seedProjectFixture({ role: "owner" }));
	});

	it("returns 501 when WORKSPACE_HUB is not configured (graceful degradation)", async () => {
		const res = await SELF.fetch(`http://localhost/api/workspaces/${slug}/realtime`, {
			headers: {
				...authHeaders(token, slug),
				Upgrade: "websocket",
			},
		});
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("Realtime WebSockets are not enabled");
	});

	it("broadcastWorkspaceEvent is a silent no-op when WORKSPACE_HUB is undefined", async () => {
		const ctx: ServiceCtx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId,
			userId,
		};

		await expect(
			broadcastWorkspaceEvent(ctx, {
				type: "issue.created",
				projectId,
				data: { id: "test-id" },
			})
		).resolves.toBeUndefined();
	});

	it("WorkspaceHub handles WebSocket upgrade, ping/pong, and subscription filtering", async () => {
		const state = {
			acceptWebSocket: vi.fn(),
			getWebSockets: vi.fn().mockReturnValue([]),
		};

		const hub = new WorkspaceHub(state as unknown as DurableObjectState, env as unknown as Env);

		// Non-websocket request
		const httpReq = new Request("http://localhost/realtime");
		const httpRes = await hub.fetch(httpReq);
		expect(httpRes.status).toBe(426);

		// WebSocket upgrade request
		const wsReq = new Request("http://localhost/realtime", {
			headers: { Upgrade: "websocket" },
		});
		const wsRes = await hub.fetch(wsReq);
		expect(wsRes.status).toBe(101);
		expect(state.acceptWebSocket).toHaveBeenCalled();

		// Test ping message
		const mockWs = {
			send: vi.fn(),
			serializeAttachment: vi.fn(),
			deserializeAttachment: vi.fn().mockReturnValue({ subscribedAt: 12345 }),
			close: vi.fn(),
		};

		await hub.webSocketMessage(mockWs as unknown as WebSocket, JSON.stringify({ action: "ping" }));
		expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"pong"'));

		// Test subscribe message
		await hub.webSocketMessage(
			mockWs as unknown as WebSocket,
			JSON.stringify({
				action: "subscribe",
				projects: [projectId],
				eventTypes: ["issue.*"],
			})
		);
		expect(mockWs.serializeAttachment).toHaveBeenCalledWith(
			expect.objectContaining({
				filters: {
					projects: [projectId],
					eventTypes: ["issue.*"],
				},
			})
		);
		expect(mockWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"subscribed"'));
	});

	it("WorkspaceHub.broadcast sends events to matching sockets and filters non-matching", async () => {
		const matchingWs = {
			send: vi.fn(),
			deserializeAttachment: vi.fn().mockReturnValue({
				filters: {
					projects: [projectId],
					eventTypes: ["issue.*"],
				},
			}),
		};

		const otherProjectWs = {
			send: vi.fn(),
			deserializeAttachment: vi.fn().mockReturnValue({
				filters: {
					projects: ["other-project-id"],
					eventTypes: ["issue.*"],
				},
			}),
		};

		const otherTypeWs = {
			send: vi.fn(),
			deserializeAttachment: vi.fn().mockReturnValue({
				filters: {
					projects: [projectId],
					eventTypes: ["comment.*"],
				},
			}),
		};

		const state = {
			acceptWebSocket: vi.fn(),
			getWebSockets: vi.fn().mockReturnValue([matchingWs, otherProjectWs, otherTypeWs]),
		};

		const hub = new WorkspaceHub(state as unknown as DurableObjectState, env as unknown as Env);

		const result = await hub.broadcast({
			type: "issue.created",
			workspaceId,
			projectId,
			data: { id: "issue-123", title: "Test" },
			timestamp: Math.floor(Date.now() / 1000),
		});

		expect(result.recipientCount).toBe(1);
		expect(matchingWs.send).toHaveBeenCalledWith(expect.stringContaining('"type":"issue.created"'));
		expect(otherProjectWs.send).not.toHaveBeenCalled();
		expect(otherTypeWs.send).not.toHaveBeenCalled();
	});

	it("dispatches broadcast event when creating an issue with WORKSPACE_HUB stub", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(JSON.stringify({ recipientCount: 1 })));
		const mockStub = {
			fetch: fetchMock,
		};
		const mockHubNamespace = {
			idFromName: vi.fn().mockReturnValue("mock-do-id"),
			get: vi.fn().mockReturnValue(mockStub),
		};

		const ctx: ServiceCtx = {
			db: env.DB,
			kv: env.KV,
			r2: env.R2,
			workspaceId,
			userId,
			role: "owner",
			workspaceHub: mockHubNamespace as unknown as DurableObjectNamespace,
		};

		const created = await createIssue(ctx, {
			projectId,
			title: "Realtime test issue",
		});

		expect(created.id).toBeTruthy();
		expect(fetchMock).toHaveBeenCalledWith(
			"http://do/broadcast",
			expect.objectContaining({
				method: "POST",
				body: expect.stringContaining('"type":"issue.created"'),
			})
		);
	});
});
