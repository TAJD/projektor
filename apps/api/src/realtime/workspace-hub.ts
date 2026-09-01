import { drizzle, schema } from "@projektor/db";
import type { Env, RealtimeEvent, Role } from "@projektor/types";
import { and, eq } from "drizzle-orm";
import { visibleProjectIds } from "../services/access";
import type { ServiceCtx } from "../services/types";

export interface SubscriptionFilters {
	projects?: string[];
	eventTypes?: string[];
}

export interface SocketAttachment {
	userId: string;
	workspaceId: string;
	role?: Role;
	visibleProjectIds: string[];
	subscribedAt: number;
	snapshotAt: number;
	filters?: SubscriptionFilters;
}

const INTERNAL_USER_ID_HEADER = "X-Internal-User-Id";
const INTERNAL_WORKSPACE_ID_HEADER = "X-Internal-Workspace-Id";
const INTERNAL_ROLE_HEADER = "X-Internal-Role";

// How long a visibility/role snapshot is trusted on a hibernated socket before
// it is refreshed from D1. Bounds stale access after admin demotion or removal.
const SNAPSHOT_TTL_SECONDS = 300;

function isWorkspaceAdmin(role: Role | undefined): boolean {
	return role === "owner" || role === "admin";
}

export class WorkspaceHub {
	ctx: DurableObjectState;
	env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/broadcast" && request.method === "POST") {
			try {
				const event = (await request.json()) as RealtimeEvent;
				const result = await this.broadcast(event);
				return new Response(JSON.stringify(result), {
					headers: { "Content-Type": "application/json" },
				});
			} catch {
				return new Response(JSON.stringify({ error: "Invalid broadcast payload" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}

		const upgradeHeader = request.headers.get("Upgrade");
		if (upgradeHeader !== "websocket") {
			return new Response("Expected Upgrade: websocket", { status: 426 });
		}

		const identity = this.resolveIdentity(request);
		if (!identity) {
			return new Response("Unauthorized", { status: 401 });
		}

		const visibleIds = await this.loadVisibleProjectIds(identity);

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.ctx.acceptWebSocket(server);

		const now = Math.floor(Date.now() / 1000);
		const initialAttachment: SocketAttachment = {
			userId: identity.userId,
			workspaceId: identity.workspaceId,
			role: identity.role,
			visibleProjectIds: visibleIds,
			subscribedAt: now,
			snapshotAt: now,
		};
		server.serializeAttachment(initialAttachment);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	private resolveIdentity(
		request: Request
	): { userId: string; workspaceId: string; role: Role } | null {
		const userId = request.headers.get(INTERNAL_USER_ID_HEADER);
		const workspaceId = request.headers.get(INTERNAL_WORKSPACE_ID_HEADER);
		const role = request.headers.get(INTERNAL_ROLE_HEADER) as Role | null;
		if (!userId || !workspaceId || !role) return null;
		return { userId, workspaceId, role };
	}

	private buildServiceCtx(identity: {
		userId: string;
		workspaceId: string;
		role?: Role;
	}): ServiceCtx {
		return {
			db: this.env.DB,
			kv: this.env.KV,
			r2: this.env.R2,
			workspaceId: identity.workspaceId,
			userId: identity.userId,
			role: identity.role,
		};
	}

	private async loadVisibleProjectIds(identity: {
		userId: string;
		workspaceId: string;
		role?: Role;
	}): Promise<string[]> {
		return visibleProjectIds(this.buildServiceCtx(identity));
	}

	private async refreshSnapshot(attachment: SocketAttachment): Promise<SocketAttachment> {
		const orm = drizzle(this.env.DB, { schema });
		const membership = await orm
			.select({ role: schema.workspaceMembers.role })
			.from(schema.workspaceMembers)
			.where(
				and(
					eq(schema.workspaceMembers.workspaceId, attachment.workspaceId),
					eq(schema.workspaceMembers.userId, attachment.userId)
				)
			)
			.get();

		const role = membership ? (membership.role as Role) : undefined;
		const visibleProjectIds = membership
			? await this.loadVisibleProjectIds({
					userId: attachment.userId,
					workspaceId: attachment.workspaceId,
					role,
				})
			: [];

		return {
			...attachment,
			role,
			visibleProjectIds,
			snapshotAt: Math.floor(Date.now() / 1000),
		};
	}

	private isSnapshotStale(attachment: SocketAttachment): boolean {
		return Math.floor(Date.now() / 1000) - attachment.snapshotAt > SNAPSHOT_TTL_SECONDS;
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return;

		try {
			const data = JSON.parse(message) as {
				action?: string;
				projects?: unknown[];
				eventTypes?: unknown[];
			};

			let attachment = ws.deserializeAttachment() as SocketAttachment | null;
			if (!attachment) return;

			if (this.isSnapshotStale(attachment)) {
				attachment = await this.refreshSnapshot(attachment);
				ws.serializeAttachment(attachment);
			}

			if (data.action === "ping") {
				ws.send(JSON.stringify({ type: "pong", timestamp: Math.floor(Date.now() / 1000) }));
				return;
			}

			if (data.action === "subscribe") {
				const allowedProjects = new Set(attachment.visibleProjectIds);
				const requestedProjects = Array.isArray(data.projects)
					? data.projects.filter((id): id is string => typeof id === "string")
					: undefined;

				let effectiveProjects: string[] | undefined;
				if (requestedProjects) {
					// Intersect the client-supplied list with the server-side visible set.
					effectiveProjects = requestedProjects.filter((id) => allowedProjects.has(id));
				} else if (!isWorkspaceAdmin(attachment.role)) {
					// Non-admin with no explicit filter defaults to their visible set,
					// never "every project in the workspace".
					effectiveProjects = attachment.visibleProjectIds;
				}

				const filters: SubscriptionFilters = {
					projects: effectiveProjects,
					eventTypes: Array.isArray(data.eventTypes)
						? data.eventTypes.filter((t): t is string => typeof t === "string")
						: undefined,
				};

				ws.serializeAttachment({
					...attachment,
					filters,
				});

				ws.send(
					JSON.stringify({
						type: "subscribed",
						filters,
						timestamp: Math.floor(Date.now() / 1000),
					})
				);
			}
		} catch {
			// Ignore malformed client JSON
		}
	}

	async webSocketClose(
		ws: WebSocket,
		code: number,
		_reason: string,
		_wasClean: boolean
	): Promise<void> {
		ws.close(code, "Closed");
	}

	async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		ws.close(1011, "Internal error");
	}

	async broadcast(event: RealtimeEvent): Promise<{ recipientCount: number }> {
		const sockets = this.ctx.getWebSockets();
		let recipientCount = 0;
		const payload = JSON.stringify(event);

		for (const ws of sockets) {
			try {
				const attachment = ws.deserializeAttachment() as SocketAttachment | null;
				if (!attachment) continue;

				// Server-side project visibility check: non-admins must receive only
				// events scoped to a project they can see. Missing projectId is treated
				// as "deny" for non-admins (fail-closed).
				if (!isWorkspaceAdmin(attachment.role)) {
					if (!event.projectId) continue;
					const visible = new Set(attachment.visibleProjectIds);
					if (!visible.has(event.projectId)) {
						continue;
					}
				}

				const filters = attachment.filters;

				// Apply the client-requested project filter (already intersected with
				// visibility at subscribe time, but re-checking is cheap and robust).
				if (filters?.projects && filters.projects.length > 0 && event.projectId) {
					if (!filters.projects.includes(event.projectId)) {
						continue;
					}
				}

				if (filters?.eventTypes && filters.eventTypes.length > 0) {
					const matched = filters.eventTypes.some((pattern) => {
						if (pattern.endsWith(".*")) {
							const prefix = pattern.slice(0, -2);
							return event.type.startsWith(`${prefix}.`) || event.type === prefix;
						}
						return pattern === event.type;
					});
					if (!matched) {
						continue;
					}
				}

				ws.send(payload);
				recipientCount++;
			} catch {
				// Socket closed or failed to send
			}
		}

		return { recipientCount };
	}
}
