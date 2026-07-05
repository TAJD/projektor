import type { Config } from "drizzle-kit";

// cofferdam-ignore: Design.OrphanExport: drizzle-kit CLI convention — loaded by file path, not a JS import
export default {
	schema: "./src/schema/*",
	out: "./migrations",
	dialect: "sqlite",
} satisfies Config;
