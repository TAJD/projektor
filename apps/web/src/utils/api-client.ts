function buildHeaders(
	workspaceSlug: string | undefined,
	extra: Record<string, string> = {}
): Record<string, string> {
	const h: Record<string, string> = { ...extra };
	if (workspaceSlug) h["X-Workspace-Slug"] = workspaceSlug;
	return h;
}

/** Thrown when `apiFetch`'s underlying `fetch` call rejects (network failure/offline), as opposed to a completed HTTP error response. */
export class ApiOfflineError extends Error {
	constructor(path: string, method: string) {
		super(`API ${method} ${path} failed: network unavailable`);
		this.name = "ApiOfflineError";
	}
}

/** Thrown when the Cloudflare Access session is gone and reloading has already failed to restore it. */
export class SessionExpiredError extends Error {
	constructor() {
		super("Your session has expired. Use Log in to start a new one.");
		this.name = "SessionExpiredError";
	}
}

// Set once a 401 triggers window.location.reload(). The reload doesn't tear down the
// page instantly, so other in-flight calls can still land (or get aborted by the
// navigation) in the meantime — once we're reloading, suppress their errors too rather
// than flashing an unrelated "failed to load"/offline error right before the page goes away.
let reauthReloadInFlight = false;

// PROJ-430: the reload above only restores a session if the navigation actually
// reaches Cloudflare Access. When it doesn't, the reloaded page 401s immediately and
// reloads again — an unattended tab did this all night, thousands of times. Persist the
// attempt across the navigation (module state doesn't survive it) so the second 401
// surfaces to the user instead of starting another lap.
const REAUTH_MARKER_KEY = "projektor:reauth-attempted-at";
const REAUTH_MARKER_TTL_MS = 60_000;

// Read once per page load rather than on every response: the marker only changes
// when we set or clear it below.
let reauthAttemptedAt: number | null = readReauthMarker();

function readReauthMarker(): number | null {
	try {
		const raw = sessionStorage.getItem(REAUTH_MARKER_KEY);
		const at = raw === null ? Number.NaN : Number(raw);
		return Number.isFinite(at) && Date.now() - at < REAUTH_MARKER_TTL_MS ? at : null;
	} catch {
		// Storage blocked (private mode, cookies-off). Degrade to the pre-PROJ-430
		// behaviour — reload every time — rather than refusing to re-authenticate.
		return null;
	}
}

function markReauthAttempt(): void {
	reauthAttemptedAt = Date.now();
	try {
		sessionStorage.setItem(REAUTH_MARKER_KEY, String(reauthAttemptedAt));
	} catch {}
}

function clearReauthMarker(): void {
	reauthAttemptedAt = null;
	try {
		sessionStorage.removeItem(REAUTH_MARKER_KEY);
	} catch {}
}

/** Test-only: reset module state between tests (see the module-level state above). */
export function __resetApiFetchStateForTests(): void {
	reauthReloadInFlight = false;
	reauthAttemptedAt = readReauthMarker();
}

export async function apiFetch<T = unknown>(
	path: string,
	opts: {
		workspaceSlug?: string;
		method?: string;
		body?: unknown;
		headers?: Record<string, string>;
		on401?: "reload" | "throw";
	} = {}
): Promise<T> {
	const isFormData = opts.body instanceof FormData;
	const method = opts.method ?? "GET";
	let res: Response;
	try {
		res = await fetch(path, {
			method,
			credentials: "include",
			headers: {
				...buildHeaders(opts.workspaceSlug, opts.headers),
				...(opts.body && !isFormData ? { "Content-Type": "application/json" } : {}),
			},
			...(opts.body
				? { body: isFormData ? (opts.body as FormData) : JSON.stringify(opts.body) }
				: {}),
		});
	} catch {
		if (reauthReloadInFlight) return new Promise<T>(() => {});
		throw new ApiOfflineError(path, method);
	}
	if (!res.ok) {
		// A 401 here means the Cloudflare Access session expired mid-use (the app itself
		// never prompts re-login). Reload so Access can challenge and bounce the user back.
		if (res.status === 401) {
			if (opts.on401 === "throw") {
				throw new Error(`API ${method} ${path} failed: 401`);
			}
			if (reauthAttemptedAt !== null) throw new SessionExpiredError();
			markReauthAttempt();
			reauthReloadInFlight = true;
			window.location.reload();
			return new Promise<T>(() => {});
		}
		if (reauthReloadInFlight) return new Promise<T>(() => {});
		throw new Error(`API ${method} ${path} failed: ${res.status}`);
	}
	// A working request proves the session is good again — re-arm the guard so a
	// later expiry gets its own reload attempt.
	if (reauthAttemptedAt !== null) clearReauthMarker();
	return res.json() as Promise<T>;
}
