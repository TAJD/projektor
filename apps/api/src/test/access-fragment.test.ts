import { describe, expect, it } from "vitest";
import { visibleProjectSqlFragment } from "../services/access";
import type { ServiceCtx } from "../services/types";

// PROJ-317: visibleProjectSqlFragment inlines its column expression verbatim into
// raw SQL, so it must reject anything that isn't a bare/qualified column identifier
// before it can become an injection vector.

const memberCtx = { role: "member", userId: "u1" } as unknown as ServiceCtx;
const ownerCtx = { role: "owner", userId: "u1" } as unknown as ServiceCtx;

describe("visibleProjectSqlFragment column-expression guard", () => {
	it("accepts a bare or table-qualified column identifier", () => {
		expect(visibleProjectSqlFragment(memberCtx, "project_id")).not.toBeNull();
		const frag = visibleProjectSqlFragment(memberCtx, "i.project_id");
		expect(frag?.params).toEqual(["u1"]);
		expect(frag?.sql).toContain("gpg.project_id = i.project_id");
	});

	it("returns null for owner/admin (no filter) but still validates the expression", () => {
		expect(visibleProjectSqlFragment(ownerCtx, "i.project_id")).toBeNull();
		expect(() => visibleProjectSqlFragment(ownerCtx, "i.project_id; DROP TABLE issues")).toThrow();
	});

	it("throws on anything that is not a column identifier", () => {
		for (const bad of [
			"i.project_id; DROP TABLE issues",
			"(SELECT 1)",
			"i.project_id OR 1=1",
			"i.project_id, name",
			"",
			"1",
		]) {
			expect(() => visibleProjectSqlFragment(memberCtx, bad)).toThrow(/column identifier/);
		}
	});
});
