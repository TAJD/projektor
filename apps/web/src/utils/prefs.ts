export type ThemePref = "system" | "light" | "dark";
export type DensityPref = "comfortable" | "compact";
export type SidebarPref = "expanded" | "collapsed";

export interface Prefs {
	theme: ThemePref;
	density: DensityPref;
	sidebar: SidebarPref;
}

const STORAGE_KEY = "prefs";
const LEGACY_THEME_KEY = "theme";

const DEFAULTS: Prefs = { theme: "system", density: "comfortable", sidebar: "expanded" };

function isThemePref(v: unknown): v is ThemePref {
	return v === "system" || v === "light" || v === "dark";
}
function isDensityPref(v: unknown): v is DensityPref {
	return v === "comfortable" || v === "compact";
}
function isSidebarPref(v: unknown): v is SidebarPref {
	return v === "expanded" || v === "collapsed";
}

export function readPrefs(): Prefs {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			return {
				theme: isThemePref(parsed?.theme) ? parsed.theme : DEFAULTS.theme,
				density: isDensityPref(parsed?.density) ? parsed.density : DEFAULTS.density,
				sidebar: isSidebarPref(parsed?.sidebar) ? parsed.sidebar : DEFAULTS.sidebar,
			};
		}
		const legacyTheme = localStorage.getItem(LEGACY_THEME_KEY);
		if (isThemePref(legacyTheme)) return { ...DEFAULTS, theme: legacyTheme };
	} catch {}
	return { ...DEFAULTS };
}

export function writePrefs(prefs: Prefs): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
		localStorage.removeItem(LEGACY_THEME_KEY);
	} catch {}
}

export function applyPrefsToDocument(prefs: Prefs): void {
	const root = document.documentElement;
	if (prefs.theme === "system") root.removeAttribute("data-theme");
	else root.setAttribute("data-theme", prefs.theme);
	root.setAttribute("data-density", prefs.density);
	root.setAttribute("data-sidebar", prefs.sidebar);
}
