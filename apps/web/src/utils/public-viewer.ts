import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "./api-client";

// PROJ-373 anonymous fallback — apps/api/src/middleware/auth.ts
export const PUBLIC_VIEWER_EMAIL = "public-viewer@projektor.local";

/**
 * True once we've confirmed the current session is the PROJ-373 anonymous
 * read-only demo viewer (starts false, so writes aren't hidden pre-flight).
 */
export function usePublicViewer(workspaceSlug: string | undefined): boolean {
	const [isPublicViewer, setIsPublicViewer] = useState(false);

	useEffect(() => {
		let cancelled = false;
		apiFetch<{ user: { email: string } }>("/auth/me", { workspaceSlug, on401: "throw" })
			.then((data) => {
				if (!cancelled) setIsPublicViewer(data.user.email === PUBLIC_VIEWER_EMAIL);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, [workspaceSlug]);

	return isPublicViewer;
}
