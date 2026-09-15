export interface BrandConfig {
	name: string;
	mark: string;
	accent: string | null;
	onAccent: string | null;
	logoUrl: string | null;
}

const DEFAULT_NAME = "Projektor";
const DEFAULT_MARK = "P";

function replaceBrandName(text: string, name: string): string {
	return text.replace(/^Projektor\b/, name);
}

export function applyBrandToDocument(brand: BrandConfig): void {
	if (brand.name !== DEFAULT_NAME) {
		document.title = replaceBrandName(document.title, brand.name);
		for (const selector of [
			'meta[name="description"]',
			'meta[property="og:title"]',
			'meta[property="og:description"]',
		]) {
			const el = document.querySelector(selector);
			if (el)
				el.setAttribute("content", replaceBrandName(el.getAttribute("content") ?? "", brand.name));
		}
		const appleTitle = document.querySelector('meta[name="apple-mobile-web-app-title"]');
		if (appleTitle) appleTitle.setAttribute("content", brand.name);
		const brandNameEl = document.querySelector(".topbar-brand .brand-name");
		if (brandNameEl) brandNameEl.textContent = brand.name;
	}

	if (brand.mark !== DEFAULT_MARK) {
		const markEl = document.querySelector(".topbar-brand .brand-mark");
		if (markEl) markEl.textContent = brand.mark;
	}

	if (brand.logoUrl) {
		for (const selector of ['link[rel="icon"]', 'link[rel="apple-touch-icon"]']) {
			const el = document.querySelector(selector);
			if (el) el.setAttribute("href", brand.logoUrl);
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

export async function applyBrand(fetchImpl: typeof fetch = fetch): Promise<void> {
	try {
		const res = await fetchImpl("/api/config/brand");
		if (!res.ok) return;
		applyBrandToDocument((await res.json()) as BrandConfig);
	} catch {}
}
