import type { RealtimeEvent } from "@projektor/types";
import type { ServiceCtx } from "./types";

export type EventInput = Omit<RealtimeEvent, "workspaceId" | "timestamp">;

/**
 * Dispatches a realtime event to the workspace's Durable Object hub.
 *
 * If WORKSPACE_HUB is not configured (e.g. 1-click or free-tier deployments),
 * this function is a no-op and completes immediately.
 */
export async function broadcastWorkspaceEvent(ctx: ServiceCtx, event: EventInput): Promise<void> {
	if (!ctx.workspaceHub) return;

	const fullEvent: RealtimeEvent = {
		...event,
		workspaceId: ctx.workspaceId,
		timestamp: Math.floor(Date.now() / 1000),
	};

	try {
		const stub = ctx.workspaceHub.get(ctx.workspaceHub.idFromName(ctx.workspaceId));
		const sendPromise = (stub as unknown as { broadcast: (e: RealtimeEvent) => Promise<unknown> })
			.broadcast(fullEvent)
			.catch(() => {
				// Prevent broadcast errors from affecting the calling service
			});

		if (ctx.waitUntil) {
			ctx.waitUntil(sendPromise);
		} else {
			await sendPromise;
		}
	} catch {
		// Durable Object dispatch failed or unavailable; swallow silently to preserve DB write integrity
	}
}
