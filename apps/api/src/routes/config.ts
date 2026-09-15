import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";

const router = new Hono<HonoEnv>();

export function deriveBrandMark(name: string): string {
	const trimmed = name.trim();
	return trimmed ? trimmed[0].toUpperCase() : "P";
}

router.get("/brand", (c) => {
	const name = c.env.BRAND_NAME?.trim() || "Projektor";
	return c.json(
		{
			name,
			mark: c.env.BRAND_MARK?.trim() || deriveBrandMark(name),
			accent: c.env.BRAND_ACCENT?.trim() || null,
			onAccent: c.env.BRAND_ON_ACCENT?.trim() || null,
			logoUrl: c.env.BRAND_LOGO_URL?.trim() || null,
		},
		200,
		{ "Cache-Control": "public, max-age=300" }
	);
});

export { router as configRouter };
