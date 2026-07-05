import { useEffect, useRef, useState } from "preact/hooks";

// cofferdam-ignore: Design.OrphanExport: shared hook, not yet adopted by any island (PROJ-259)
export function useFetch<T>(url: string | null, headers: Record<string, string>) {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const headersRef = useRef(headers);
	headersRef.current = headers;

	useEffect(() => {
		if (!url) {
			setLoading(false);
			return;
		}
		setLoading(true);
		setError(null);
		let cancelled = false;
		fetch(url, { credentials: "include", headers: headersRef.current })
			.then((r) => (r.ok ? (r.json() as Promise<T>) : Promise.reject(`HTTP ${r.status}`)))
			.then((d) => {
				if (!cancelled) {
					setData(d);
					setLoading(false);
				}
			})
			.catch((e: unknown) => {
				if (!cancelled) {
					setError(String(e));
					setLoading(false);
				}
			});
		return () => {
			cancelled = true;
		};
	}, [url]);

	return { data, loading, error };
}
