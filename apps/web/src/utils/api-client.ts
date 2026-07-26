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

// Set once a 401 triggers window.location.reload(). The reload doesn't tear down the
// page instantly, so other in-flight calls can still land (or get aborted by the
// navigation) in the meantime — once we're reloading, suppress their errors too rather
// than flashing an unrelated "failed to load"/offline error right before the page goes away.
let reauthReloadInFlight = false;

/** Test-only: reset module state between tests (see the module-level flag above). */
export function __resetApiFetchStateForTests(): void {
	reauthReloadInFlight = false;
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
			reauthReloadInFlight = true;
			window.location.reload();
			return new Promise<T>(() => {});
		}
		if (reauthReloadInFlight) return new Promise<T>(() => {});
		throw new Error(`API ${method} ${path} failed: ${res.status}`);
	}
	return res.json() as Promise<T>;
}
