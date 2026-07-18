import { useEffect, useState } from "preact/hooks";

/** Minimal offline indicator (PROJ-414) — the app shell loads from the service-worker cache
 * even offline, but data-fetching islands otherwise fail silently with no shared signal. */
export function OfflineBanner() {
	const [online, setOnline] = useState(true);

	useEffect(() => {
		setOnline(navigator.onLine);
		const goOnline = () => setOnline(true);
		const goOffline = () => setOnline(false);
		window.addEventListener("online", goOnline);
		window.addEventListener("offline", goOffline);
		return () => {
			window.removeEventListener("online", goOnline);
			window.removeEventListener("offline", goOffline);
		};
	}, []);

	if (online) return null;

	return (
		<div
			role="status"
			class="px-3 py-1.5 text-sm font-medium text-center"
			style={{ background: "var(--danger-bg)", color: "var(--danger-text)" }}
		>
			You're offline — changes won't save until your connection returns.
		</div>
	);
}
