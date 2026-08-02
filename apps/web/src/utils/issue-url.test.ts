import { describe, expect, it } from "vitest";
import { issueUrl } from "./issue-url";

describe("issueUrl", () => {
	it("builds the pretty project/issue URL when a project slug is given", () => {
		expect(issueUrl("proj", 42, "Fix the Bug")).toBe("/projects/proj/issues/42/fix-the-bug");
	});

	it("falls back to the id-based URL when there is no project slug but a fallback id is given", () => {
		expect(issueUrl(null, 42, "Fix the Bug", "abc-123")).toBe("/issues/view?id=abc-123");
	});

	it("falls back to '#' when there is neither a project slug nor a fallback id", () => {
		expect(issueUrl(undefined, 42, "Fix the Bug")).toBe("#");
	});
});
