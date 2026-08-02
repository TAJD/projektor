import { describe, expect, it } from "vitest";
import { ValidationError } from "../services/errors";
import {
	parseWikiFrontmatter,
	stampWikiFrontmatterVerification,
	stripTemplateFlag,
} from "../services/wiki-frontmatter";

describe("parseWikiFrontmatter (PROJ-488)", () => {
	it("returns empty meta for content with no frontmatter block", () => {
		expect(parseWikiFrontmatter("# Just a heading\n\nbody text")).toEqual({
			type: null,
			tags: [],
			status: null,
			verifiedAt: null,
			verifiedBy: null,
			owners: [],
			verifyInterval: null,
			isTemplate: false,
		});
	});

	it("returns empty meta for an empty frontmatter block", () => {
		const result = parseWikiFrontmatter("---\n---\nbody");
		expect(result.type).toBeNull();
		expect(result.isTemplate).toBe(false);
	});

	it("parses a full frontmatter block into meta", () => {
		const content = [
			"---",
			"type: runbook",
			"tags: [ops, oncall]",
			"status: current",
			"owners: [alice]",
			"verify_interval: 30",
			"template: true",
			"---",
			"body",
		].join("\n");

		expect(parseWikiFrontmatter(content)).toEqual({
			type: "runbook",
			tags: ["ops", "oncall"],
			status: "current",
			verifiedAt: null,
			verifiedBy: null,
			owners: ["alice"],
			verifyInterval: 30,
			isTemplate: true,
		});
	});

	it("normalizes a YAML date verified_at to unix seconds", () => {
		const content = "---\nverified_at: 2026-01-01\n---\nbody";
		const result = parseWikiFrontmatter(content);
		expect(result.verifiedAt).toBe(Math.floor(new Date("2026-01-01").getTime() / 1000));
	});

	it("throws ValidationError for invalid YAML", () => {
		const content = "---\nthis: [is not: valid\n---\nbody";
		expect(() => parseWikiFrontmatter(content)).toThrow(ValidationError);
	});

	it("throws ValidationError when frontmatter is a list, not a mapping", () => {
		const content = "---\n- a\n- b\n---\nbody";
		expect(() => parseWikiFrontmatter(content)).toThrow(ValidationError);
	});

	it("throws ValidationError when a field fails schema validation", () => {
		const content = "---\nstatus: not-a-real-status\n---\nbody";
		expect(() => parseWikiFrontmatter(content)).toThrow(ValidationError);
	});

	it("throws ValidationError for an unparseable verified_at string", () => {
		const content = "---\nverified_at: not-a-date\n---\nbody";
		expect(() => parseWikiFrontmatter(content)).toThrow(ValidationError);
	});
});

describe("stripTemplateFlag (PROJ-491)", () => {
	it("returns content unchanged when there is no frontmatter", () => {
		expect(stripTemplateFlag("body only")).toBe("body only");
	});

	it("removes the template key but keeps other frontmatter keys", () => {
		const content = "---\ntype: runbook\ntemplate: true\n---\nbody";
		const result = stripTemplateFlag(content);
		expect(result).not.toContain("template");
		expect(result).toContain("type: runbook");
		expect(result).toContain("body");
	});

	it("drops the frontmatter block entirely when no keys remain", () => {
		const content = "---\ntemplate: true\n---\nbody";
		expect(stripTemplateFlag(content)).toBe("body");
	});
});

describe("stampWikiFrontmatterVerification (PROJ-489)", () => {
	it("adds a frontmatter block to a page with none", () => {
		const result = stampWikiFrontmatterVerification("body only", 1735689600, "alice");
		expect(result).toContain("verified_by: alice");
		expect(result).toContain("body only");
		expect(result.startsWith("---\n")).toBe(true);
	});

	it("preserves existing frontmatter keys while stamping verification", () => {
		const content = "---\ntype: runbook\n---\nbody";
		const result = stampWikiFrontmatterVerification(content, 1735689600, "alice");
		expect(result).toContain("type: runbook");
		expect(result).toContain("verified_by: alice");
		expect(result).toContain("body");
	});

	it("overwrites a previous verification stamp", () => {
		const content = "---\nverified_by: bob\n---\nbody";
		const result = stampWikiFrontmatterVerification(content, 1735689600, "alice");
		expect(result).toContain("verified_by: alice");
		expect(result).not.toContain("bob");
	});
});
