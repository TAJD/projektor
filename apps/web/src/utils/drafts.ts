// PROJ-431: losing a half-typed comment on a phone — backgrounded tab, dropped
// connection, accidental back — is a real pain point. Drafts are the user's own
// *unsent* input, which is why they're persisted while fetched issue data deliberately
// isn't (see the ticket's caching recommendation).

const PREFIX = "projektor:draft:";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredDraft {
	value: string;
	at: number;
}

/**
 * Build a storage key for one editable field. Scoped by workspace so a draft can never
 * surface under a different tenant.
 */
export function draftKey(workspaceSlug: string | undefined, scope: string, field: string): string {
	return `${PREFIX}${workspaceSlug ?? "-"}:${scope}:${field}`;
}

/** Returns the stored draft, or null if absent, expired or unreadable. */
export function loadDraft(key: string): string | null {
	try {
		const raw = localStorage.getItem(key);
		if (raw === null) return null;
		const parsed = JSON.parse(raw) as StoredDraft;
		if (typeof parsed?.value !== "string" || typeof parsed?.at !== "number") {
			localStorage.removeItem(key);
			return null;
		}
		if (Date.now() - parsed.at > TTL_MS) {
			localStorage.removeItem(key);
			return null;
		}
		return parsed.value;
	} catch {
		// Unreadable, blocked (private mode) or malformed — behave as if there's no draft.
		return null;
	}
}

/** Persists a draft. Empty/whitespace-only values clear the entry rather than storing it. */
export function saveDraft(key: string, value: string): void {
	try {
		if (!value.trim()) {
			localStorage.removeItem(key);
			return;
		}
		localStorage.setItem(key, JSON.stringify({ value, at: Date.now() } satisfies StoredDraft));
	} catch {
		// Quota exceeded or storage blocked. Draft persistence is a convenience, never a
		// precondition for editing — degrade silently.
	}
}

export function clearDraft(key: string): void {
	try {
		localStorage.removeItem(key);
	} catch {}
}

/**
 * Drop every stored draft. Intended for logout, so one user's unsent text isn't left
 * behind for the next person on a shared device.
 */
export function clearAllDrafts(): void {
	try {
		for (const k of Object.keys(localStorage)) {
			if (k.startsWith(PREFIX)) localStorage.removeItem(k);
		}
	} catch {}
}
