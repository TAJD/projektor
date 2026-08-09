function buildHeaders(
	workspaceSlug: string | undefined,
	extra: Record<string, string> = {}
): Record<string, string> {
	const h: Record<string, string> = { ...extra };
	if (workspaceSlug) h["X-Workspace-Slug"] = workspaceSlug;
	return h;
}

/**
 * Thrown when `apiFetch`'s underlying `fetch` call rejects (network failure/offline), as opposed
 * to a completed HTTP error response.
 */
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

// PROJ-602: several callers (WikiPage's 409/404 handling, ShareView's 404 handling) pattern-match
// on `message`'s `failed: ${status}` suffix, so it can't be widened to carry the server's detail
// text without breaking them. Carry the parsed detail separately instead — `message` keeps its
// original shape, `detail` is for callers (like IssueDetail's type-change error) that want to
// show the actual reason.
export class ApiError extends Error {
	readonly status: number;
	readonly detail: string;
	constructor(path: string, method: string, status: number, detail: string) {
		super(`API ${method} ${path} failed: ${status}`);
		this.name = "ApiError";
		this.status = status;
		this.detail = detail;
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

// PROJ-443: dedupe concurrent identical GETs so e.g. several islands mounting at once
// don't each fire the same request. Not a cache — no TTL, no stored responses; an entry
// only exists while its request is in flight, and every joiner shares the outcome
// (success or failure) of that one request. Note joiners receive the SAME parsed JSON
// object — treat responses as immutable (no current caller mutates them in place).
const inFlightGets = new Map<string, Promise<unknown>>();

/** Test-only: reset module state between tests (see the module-level state above). */
export function __resetApiFetchStateForTests(): void {
	reauthReloadInFlight = false;
	reauthAttemptedAt = readReauthMarker();
	inFlightGets.clear();
}

type ApiFetchOpts = {
	workspaceSlug?: string;
	method?: string;
	body?: unknown;
	headers?: Record<string, string>;
	on401?: "reload" | "throw";
};

export async function apiFetch<T = unknown>(path: string, opts: ApiFetchOpts = {}): Promise<T> {
	const method = opts.method ?? "GET";
	const dedupeKey = dedupeKeyFor(path, method, opts);
	if (dedupeKey === null) return apiFetchUncached<T>(path, opts, method);

	const pending = inFlightGets.get(dedupeKey);
	if (pending) return pending as Promise<T>;
	const promise: Promise<unknown> = apiFetchUncached<T>(path, opts, method);
	inFlightGets.set(dedupeKey, promise);
	promise.then(
		() => clearInFlightEntry(dedupeKey, promise),
		() => clearInFlightEntry(dedupeKey, promise)
	);
	return promise as Promise<T>;
}

// Callers passing extra headers are excluded — same path with different headers is
// not the same request. on401 is part of the key: a joiner must get the 401
// behaviour it asked for (throw vs reload), not whichever caller registered first.
function dedupeKeyFor(path: string, method: string, opts: ApiFetchOpts): string | null {
	const dedupeable =
		method === "GET" &&
		opts.body === undefined &&
		opts.headers === undefined &&
		(path.startsWith("/api/") || path.startsWith("/auth/"));
	return dedupeable ? `${path}\x00${opts.workspaceSlug ?? ""}\x00${opts.on401 ?? "reload"}` : null;
}

function clearInFlightEntry(dedupeKey: string, promise: Promise<unknown>): void {
	if (inFlightGets.get(dedupeKey) === promise) inFlightGets.delete(dedupeKey);
}

function buildRequestInit(method: string, opts: ApiFetchOpts, isFormData: boolean): RequestInit {
	return {
		method,
		credentials: "include",
		headers: {
			...buildHeaders(opts.workspaceSlug, opts.headers),
			...(opts.body && !isFormData ? { "Content-Type": "application/json" } : {}),
		},
		...(opts.body
			? { body: isFormData ? (opts.body as FormData) : JSON.stringify(opts.body) }
			: {}),
	};
}

// A 401 here means the Cloudflare Access session expired mid-use (the app itself
// never prompts re-login). Reload so Access can challenge and bounce the user back.
function handleUnauthorized<T>(
	path: string,
	method: string,
	on401: "reload" | "throw" | undefined
): Promise<T> {
	if (on401 === "throw") {
		throw new Error(`API ${method} ${path} failed: 401`);
	}
	// A reload this page load has already been triggered by an earlier 401 — this
	// is the same expiry, not a second failed attempt. Without this, whichever
	// request happens to 401 second surfaces "your session has expired" on screen
	// for the instant before the reload navigates away. Which request that is comes
	// down to effect ordering, so it moves whenever the page's fetches are
	// rearranged (it moved onto the issue page in PROJ-438).
	if (reauthReloadInFlight) return new Promise<T>(() => {});
	if (reauthAttemptedAt !== null) throw new SessionExpiredError();
	markReauthAttempt();
	reauthReloadInFlight = true;
	window.location.reload();
	return new Promise<T>(() => {});
}

// PROJ-602: a service-layer rejection (ValidationError) reaches here as `{ error: {
// formErrors: string[], fieldErrors: {...} } }` — see http/error-adapter.ts. Without this,
// every caller's catch block only ever saw the generic "failed: 400", never the actual
// reason (e.g. "Cannot change type: this epic still has child issues"), even though
// several call sites already show `String(e)` to the user assuming it would be useful.
async function describeApiError(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: { formErrors?: string[] } | string };
		if (typeof body?.error === "string") return body.error;
		const formError = body?.error?.formErrors?.[0];
		if (formError) return formError;
	} catch {
		// Not JSON, or no body — fall through to the status code.
	}
	return String(res.status);
}

async function apiFetchUncached<T>(path: string, opts: ApiFetchOpts, method: string): Promise<T> {
	const isFormData = opts.body instanceof FormData;
	let res: Response;
	try {
		res = await fetch(path, buildRequestInit(method, opts, isFormData));
	} catch {
		if (reauthReloadInFlight) return new Promise<T>(() => {});
		throw new ApiOfflineError(path, method);
	}
	if (!res.ok) {
		if (res.status === 401) return handleUnauthorized<T>(path, method, opts.on401);
		if (reauthReloadInFlight) return new Promise<T>(() => {});
		throw new ApiError(path, method, res.status, await describeApiError(res));
	}
	// A working request proves the session is good again — re-arm the guard so a
	// later expiry gets its own reload attempt.
	if (reauthAttemptedAt !== null) clearReauthMarker();
	return res.json() as Promise<T>;
}
