import type { Env, RealtimeEvent } from "@projektor/types";

export interface SubscriptionFilters {
	projects?: string[];
	eventTypes?: string[];
}

export interface SocketAttachment {
	subscribedAt: number;
	filters?: SubscriptionFilters;
}

export class WorkspaceHub {
	ctx: DurableObjectState;
	env: Env;

	constructor(ctx: DurableObjectState, env: Env) {
		this.ctx = ctx;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const upgradeHeader = request.headers.get("Upgrade");
		if (upgradeHeader !== "websocket") {
			return new Response("Expected Upgrade: websocket", { status: 426 });
		}

		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair);

		this.ctx.acceptWebSocket(server);

		const initialAttachment: SocketAttachment = {
			subscribedAt: Math.floor(Date.now() / 1000),
		};
		server.serializeAttachment(initialAttachment);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (typeof message !== "string") return;

		try {
			const data = JSON.parse(message) as {
				action?: string;
				projects?: string[];
				eventTypes?: string[];
			};

			if (data.action === "ping") {
				ws.send(JSON.stringify({ type: "pong", timestamp: Math.floor(Date.now() / 1000) }));
				return;
			}

			if (data.action === "subscribe") {
				const attachment = (ws.deserializeAttachment() as SocketAttachment | null) ?? {
					subscribedAt: Math.floor(Date.now() / 1000),
				};

				const filters: SubscriptionFilters = {
					projects: Array.isArray(data.projects) ? data.projects : undefined,
					eventTypes: Array.isArray(data.eventTypes) ? data.eventTypes : undefined,
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
				const filters = attachment?.filters;

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
