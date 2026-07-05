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
});
