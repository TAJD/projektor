import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";

const router = new Hono<HonoEnv>();

function firstChar(value: string): string {
	return [...value][0] ?? "";
}

export function deriveBrandMark(name: string): string {
	const trimmed = name.trim();
	return trimmed ? firstChar(trimmed).toUpperCase() : "P";
}

router.get("/brand", (c) => {
	const name = c.env.BRAND_NAME?.trim() || "Projektor";
	const markOverride = c.env.BRAND_MARK?.trim();
	return c.json(
		{
			name,
			mark: markOverride ? firstChar(markOverride) : deriveBrandMark(name),
			accent: c.env.BRAND_ACCENT?.trim() || null,
			onAccent: c.env.BRAND_ON_ACCENT?.trim() || null,
			logoUrl: c.env.BRAND_LOGO_URL?.trim() || null,
		},
		200,
		{ "Cache-Control": "public, max-age=300" }
	);
});

export { router as configRouter };
