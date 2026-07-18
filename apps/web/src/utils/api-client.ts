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

export async function apiFetch<T = unknown>(
	path: string,
	opts: {
		workspaceSlug?: string;
		method?: string;
		body?: unknown;
		headers?: Record<string, string>;
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
		throw new ApiOfflineError(path, method);
	}
	if (!res.ok) throw new Error(`API ${method} ${path} failed: ${res.status}`);
	return res.json() as Promise<T>;
}
