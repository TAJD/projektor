import { describe, expect, it } from "vitest";
import { drizzle, schema } from "../index";

describe("drizzle instance memoisation (PROJ-1021)", () => {
	const fakeD1 = () => ({}) as D1Database;

	it("reuses one instance per binding and schema", () => {
		const db = fakeD1();
		expect(drizzle(db, { schema })).toBe(drizzle(db, { schema }));
	});

	it("keeps bindings apart", () => {
		expect(drizzle(fakeD1(), { schema })).not.toBe(drizzle(fakeD1(), { schema }));
	});

	it("does not cache calls with other config", () => {
		const db = fakeD1();
		expect(drizzle(db)).not.toBe(drizzle(db));
		expect(drizzle(db, { schema, logger: false })).not.toBe(drizzle(db, { schema, logger: false }));
	});
});
