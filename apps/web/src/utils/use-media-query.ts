import { useEffect, useState } from "preact/hooks";

/**
 * PROJ-862: render-time media query, for when two layouts should not BOTH be in the
 * DOM (the issue list used to render the desktop table and the mobile cards and hide
 * one with CSS). Initialised synchronously so the first render already picks the right
 * layout; falls back to `false` where matchMedia is unavailable (SSR, old jsdom).
 */
export function useMediaQuery(query: string): boolean {
	const get = () =>
		typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia(query).matches
			: false;
	const [matches, setMatches] = useState(get);
	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const mql = window.matchMedia(query);
		const onChange = () => setMatches(mql.matches);
		onChange();
		mql.addEventListener?.("change", onChange);
		return () => mql.removeEventListener?.("change", onChange);
	}, [query]);
	return matches;
}
