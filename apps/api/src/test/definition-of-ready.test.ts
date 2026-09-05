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
		expect(result.missing).toEqual(["acceptance criteria"]);
	});

	it("flags everything missing for an empty body", () => {
		expect(checkDefinitionOfReady("")).toEqual({
			ready: false,
			missing: ["acceptance criteria", "scope/files"],
		});
	});

	it("flags a body with only a title as not ready", () => {
		expect(checkDefinitionOfReady("Just fix the thing, you know what I mean.")).toEqual({
			ready: false,
			missing: ["acceptance criteria", "scope/files"],
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

	const readyBase = "Scope: `src/x.ts`\n\n";
	it.each([
		["## heading", "## Acceptance criteria\n- thing"],
		["### heading", "### Acceptance criteria\n- thing"],
		["bold, colon inside, inline content", "**Acceptance criteria:** thing"],
		["bold label alone, content on next line", "**Acceptance criteria**\nthing"],
		["em dash separator", "Acceptance criteria — thing"],
		["bulleted bold", "- **Acceptance criteria:** thing"],
		["lowercase colon", "acceptance criteria: thing"],
		["bold lowercase inline", "**acceptance criteria:** thing"],
	])(
		"recognises an Acceptance criteria label written as: %s (PROJ-738 DoR rework)",
		(_name, acLine) => {
			expect(checkDefinitionOfReady(`${acLine}\n\n${readyBase}`)).toEqual({
				ready: true,
				missing: [],
			});
		}
	);
});
