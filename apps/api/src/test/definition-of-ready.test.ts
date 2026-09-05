import { describe, expect, it } from "vitest";
import { checkDefinitionOfReady } from "../services/definition-of-ready";

describe("checkDefinitionOfReady (PROJ-253)", () => {
	it("is ready when all three sections have content", () => {
		const body = [
			"## Acceptance criteria",
			"- Widget renders",
			"",
			"## Scope",
			"`src/widget.ts`",
			"",
			"## Verification",
			"`pnpm test widget`",
		].join("\n");
		expect(checkDefinitionOfReady(body)).toEqual({ ready: true, missing: [] });
	});

	it("accepts an inline file path as the scope signal", () => {
		const body = [
			"## Acceptance criteria",
			"- Widget renders",
			"",
			"Touches `src/widget.ts`.",
			"",
			"## Verification",
			"`pnpm test widget`",
		].join("\n");
		expect(checkDefinitionOfReady(body)).toEqual({ ready: true, missing: [] });
	});

	it("flags a heading with no content as missing", () => {
		const body = [
			"## Acceptance criteria",
			"",
			"## Scope",
			"`src/widget.ts`",
			"## Verification",
		].join("\n");
		const result = checkDefinitionOfReady(body);
		expect(result.ready).toBe(false);
		expect(result.missing).toEqual(["acceptance criteria", "verification"]);
	});

	it("flags everything missing for an empty body", () => {
		expect(checkDefinitionOfReady("")).toEqual({
			ready: false,
			missing: ["acceptance criteria", "scope/files", "verification"],
		});
	});

	it("flags a body with only a title as not ready", () => {
		expect(checkDefinitionOfReady("Just fix the thing, you know what I mean.")).toEqual({
			ready: false,
			missing: ["acceptance criteria", "scope/files", "verification"],
		});
	});

	it("rejects a lone non-path backtick as the scope signal (PROJ-291)", () => {
		const body = [
			"## Acceptance criteria",
			"- Does the thing",
			"",
			"Set it to `true`.",
			"",
			"## Verification",
			"runs `pnpm test`",
		].join("\n");
		const result = checkDefinitionOfReady(body);
		expect(result.ready).toBe(false);
		expect(result.missing).toContain("scope/files");
	});

	it("does not treat prose that merely mentions a section label as present (PROJ-291)", () => {
		const body = [
			"Acceptance criteria are unclear right now.",
			"We should figure them out.",
			"",
			"## Scope",
			"`src/x.ts`",
			"",
			"## Verification",
			"`pnpm test x`",
		].join("\n");
		expect(checkDefinitionOfReady(body).missing).toContain("acceptance criteria");
	});

	it("recognises colon-prefixed labels (PROJ-291)", () => {
		const body = [
			"Acceptance criteria: does the thing",
			"Scope: `src/x.ts`",
			"Verification: `pnpm test`",
		].join("\n");
		expect(checkDefinitionOfReady(body)).toEqual({ ready: true, missing: [] });
	});

	it("recognises a bold label with the colon inside and content on the same line (PROJ-738)", () => {
		const body = [
			"**Acceptance criteria:** does the thing",
			"**Scope / files:** `src/x.ts`",
			"**Verification:** `pnpm test`; manual check too",
		].join("\n");
		expect(checkDefinitionOfReady(body)).toEqual({ ready: true, missing: [] });
	});

	const readyBase = "## Acceptance criteria\n- thing\n\nScope: `src/x.ts`\n\n";
	it.each([
		["## heading", "## Verification\n`pnpm test`"],
		["### heading", "### Verification\n`pnpm test`"],
		["bold, colon inside, inline content", "**Verification:** `pnpm test`"],
		["bold label alone, content on next line", "**Verification**\n`pnpm test`"],
		["em dash separator", "Verification — `pnpm test`"],
		["bulleted bold", "- **Verification:** `pnpm test`"],
		["lowercase colon", "verification: `pnpm test`"],
		["bold lowercase inline", "**verification:** `pnpm test`"],
	])("recognises a Verification label written as: %s (PROJ-738)", (_name, verificationLine) => {
		expect(checkDefinitionOfReady(readyBase + verificationLine)).toEqual({
			ready: true,
			missing: [],
		});
	});
});
