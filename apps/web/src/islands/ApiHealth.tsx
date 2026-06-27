import { useEffect, useState } from "preact/hooks";

export default function ApiHealth() {
	const [status, setStatus] = useState<string>("checking…");

	useEffect(() => {
		fetch("/api/health")
			.then((r) => (r.ok ? "ok" : `error ${r.status}`))
			.catch(() => "unreachable")
			.then(setStatus);
	}, []);

	return <p style={{ fontSize: "0.9rem", color: "#666" }}>API status: {status}</p>;
}
