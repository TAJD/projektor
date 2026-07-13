import { describe, expect, it } from "vitest";
import { isExternallyVerifiableEvidence } from "../services/evidence-classification";

describe("isExternallyVerifiableEvidence (PROJ-375)", () => {
	it("is not verifiable for plain prose", () => {
		expect(isExternallyVerifiableEvidence("Ran the tests locally, all green.")).toBe(false);
		expect(isExternallyVerifiableEvidence("manually tested in the browser")).toBe(false);
	});

	it("is verifiable given a PR URL", () => {
		expect(
			isExternallyVerifiableEvidence("See https://github.com/TAJD/projektor/pull/93 — CI green.")
		).toBe(true);
	});

	it("is verifiable given a CI run URL", () => {
		expect(
			isExternallyVerifiableEvidence(
				"CI: https://github.com/TAJD/projektor/actions/runs/29292287652"
			)
		).toBe(true);
	});

	it("is verifiable given a commit URL", () => {
		expect(
			isExternallyVerifiableEvidence(
				"Fixed in https://github.com/TAJD/projektor/commit/b6ca8a7f9271a6fb6e67d7247e1e9692088e5d48"
			)
		).toBe(true);
	});

	it("is verifiable given a bare commit SHA", () => {
		expect(isExternallyVerifiableEvidence("Verified at commit b6ca8a7f927")).toBe(true);
	});

	it("is not verifiable for a short non-hex word that happens to look like a token", () => {
		expect(isExternallyVerifiableEvidence("looks good, ship it")).toBe(false);
	});
});
