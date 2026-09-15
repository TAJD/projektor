export interface BrandConfig {
	name: string;
	mark: string;
	accent: string | null;
	onAccent: string | null;
	logoUrl: string | null;
}

const DEFAULT_NAME = "Projektor";
const DEFAULT_MARK = "P";

let cached: BrandConfig | null = null;

export function getBrandName(): string {
	return cached && typeof cached.name === "string" ? cached.name : DEFAULT_NAME;
}

function replaceBrandName(text: string, name: string): string {
	return text.replace(/\bProjektor\b/g, name);
}

export function applyBrandToDocument(brand: BrandConfig): void {
	const name = typeof brand.name === "string" && brand.name ? brand.name : DEFAULT_NAME;
	const mark = typeof brand.mark === "string" && brand.mark ? brand.mark : DEFAULT_MARK;

	if (name !== DEFAULT_NAME) {
		document.title = replaceBrandName(document.title, name);
		for (const selector of [
			'meta[name="description"]',
			'meta[property="og:title"]',
			'meta[property="og:description"]',
		]) {
			const el = document.querySelector(selector);
			if (el) el.setAttribute("content", replaceBrandName(el.getAttribute("content") ?? "", name));
		}
		const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
		if (appleTitle) appleTitle.setAttribute("content", name);
		const brandNameEl = document.querySelector(".topbar-brand .brand-name");
		if (brandNameEl) brandNameEl.textContent = name;
	}

	if (mark !== DEFAULT_MARK) {
		const markEl = document.querySelector(".topbar-brand .brand-mark");
		if (markEl) markEl.textContent = mark;
	}

	if (brand.logoUrl) {
		for (const selector of ['link[rel="icon"]', 'link[rel="apple-touch-icon"]']) {
			const el = document.querySelector(selector);
			if (el) {
				el.setAttribute("href", brand.logoUrl);
				el.removeAttribute("type");
			}
		}
	}

	if (brand.accent) {
		document.documentElement.style.setProperty("--light-accent", brand.accent);
		document.documentElement.style.setProperty("--dark-accent", brand.accent);
		for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
			meta.setAttribute("content", brand.accent);
		}
	}
	if (brand.onAccent) {
		document.documentElement.style.setProperty("--light-on-accent", brand.onAccent);
		document.documentElement.style.setProperty("--dark-on-accent", brand.onAccent);
	}
}

export function applyCachedBrand(): void {
	if (cached) applyBrandToDocument(cached);
}

export async function applyBrand(fetchImpl: typeof fetch = fetch): Promise<void> {
	if (cached) {
		applyBrandToDocument(cached);
		return;
	}
	try {
		const res = await fetchImpl("/api/config/brand");
		if (!res.ok) return;
		const brand = (await res.json()) as BrandConfig;
		cached = brand;
		applyBrandToDocument(brand);
	} catch {}
}
