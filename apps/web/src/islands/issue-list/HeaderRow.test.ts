import { describe, expect, it } from "vitest";
import { scopeSuffix } from "./HeaderRow";

// The Issues tab is workspace-wide unless filtered; the count line must say which,
// because it sits under a single project's header.
describe("scopeSuffix", () => {
	it("says 'across all projects' when unfiltered and there is more than one project", () => {
		expect(scopeSuffix("", 3)).toBe(" across all projects");
	});
	it("says nothing extra when the workspace has a single project", () => {
		expect(scopeSuffix("", 1)).toBe("");
	});
	it("names the filtered project", () => {
		expect(scopeSuffix("WEB", 3)).toBe(" in WEB");
	});
});
