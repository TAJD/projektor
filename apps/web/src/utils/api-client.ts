export function buildHeaders(
	workspaceSlug: string | undefined,
	extra: Record<string, string> = {}
): Record<string, string> {
	const h: Record<string, string> = { ...extra };
	if (workspaceSlug) h["X-Workspace-Slug"] = workspaceSlug;
	return h;
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
	const res = await fetch(path, {
		method: opts.method ?? "GET",
		credentials: "include",
		headers: {
			...buildHeaders(opts.workspaceSlug, opts.headers),
			...(opts.body && !isFormData ? { "Content-Type": "application/json" } : {}),
		},
		...(opts.body
			? { body: isFormData ? (opts.body as FormData) : JSON.stringify(opts.body) }
			: {}),
	});
	if (!res.ok) throw new Error(`API ${opts.method ?? "GET"} ${path} failed: ${res.status}`);
	return res.json() as Promise<T>;
}
