import { useEffect, useState } from "preact/hooks";
import { apiFetch } from "../utils/api-client";

export default function ApiHealth() {
	const [status, setStatus] = useState<string>("checking…");

	useEffect(() => {
		apiFetch("/api/health")
			.then(() => "ok")
			.catch(() => "unreachable")
			.then(setStatus);
	}, []);

	return <p class="text-[0.9rem] text-text-muted">API status: {status}</p>;
}
