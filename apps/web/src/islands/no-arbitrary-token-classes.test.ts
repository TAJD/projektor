import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function collectTsxFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...collectTsxFiles(full));
		} else if (entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) {
			files.push(full);
		}
	}
	return files;
}

describe("islands never reintroduce raw var() Tailwind arbitrary values (PROJ-756)", () => {
	it("no *.tsx file under islands/ contains a -[var(--...)] class", () => {
		const offenders = collectTsxFiles(__dirname).filter((file) =>
			/-\[var\(--/.test(readFileSync(file, "utf-8"))
		);

		expect(offenders).toEqual([]);
	});
});
