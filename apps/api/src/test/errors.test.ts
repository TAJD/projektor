import { describe, expect, it } from "vitest";
import { serviceErrToResponse } from "../http/error-adapter";
import { toMcpError } from "../mcp/error-adapter";
import {
	ConflictError,
	ForbiddenError,
	NotFoundError,
	ServiceError,
	ValidationError,
} from "../services/errors";

describe("ValidationError", () => {
	it("carries the zod-flattened issues and a fixed message", () => {
		const issues = { formErrors: ["bad"], fieldErrors: { title: ["required"] } };
		const err = new ValidationError(issues);
		expect(err.kind).toBe("validation");
		expect(err.message).toBe("Validation failed");
		expect(err.issues).toBe(issues);
		expect(err).toBeInstanceOf(ServiceError);
	});
});

describe("NotFoundError", () => {
	it("defaults to a generic message", () => {
		const err = new NotFoundError();
		expect(err.kind).toBe("not_found");
		expect(err.message).toBe("Not found");
	});

	it("accepts a custom message", () => {
		const err = new NotFoundError("Issue not found");
		expect(err.message).toBe("Issue not found");
	});
});

describe("ForbiddenError", () => {
	it("defaults to a generic message", () => {
		const err = new ForbiddenError();
		expect(err.kind).toBe("forbidden");
		expect(err.message).toBe("Forbidden");
	});

	it("accepts a custom message", () => {
		const err = new ForbiddenError("Not a workspace member");
		expect(err.message).toBe("Not a workspace member");
	});
});

describe("ConflictError", () => {
	it("defaults to a generic message", () => {
		const err = new ConflictError();
		expect(err.kind).toBe("conflict");
		expect(err.message).toBe("Conflict");
	});

	it("accepts a custom message", () => {
		const err = new ConflictError("Slug already taken");
		expect(err.message).toBe("Slug already taken");
	});
});

// The adapters key off `err.kind` (ServiceError) / `instanceof` to decide what a
// caller is allowed to see, so a regression there is a silent info leak or a
// wrong HTTP/JSON-RPC status. Cover both surfaces directly here.
describe("http/error-adapter: serviceErrToResponse", () => {
	const fakeCtx = { json: (body: unknown, status: number) => ({ body, status }) } as never;

	it("maps ValidationError to 400 with the issues payload", async () => {
		const issues = { formErrors: [], fieldErrors: { name: ["required"] } };
		const res = serviceErrToResponse(fakeCtx, new ValidationError(issues)) as unknown as {
			body: unknown;
			status: number;
		};
		expect(res.status).toBe(400);
		expect(res.body).toEqual({ error: issues });
	});

	it("maps NotFoundError to 404 with the message", () => {
		const res = serviceErrToResponse(fakeCtx, new NotFoundError("Issue not found")) as unknown as {
			body: unknown;
			status: number;
		};
		expect(res.status).toBe(404);
		expect(res.body).toEqual({ error: "Issue not found" });
	});

	it("maps ForbiddenError to 403 with the message", () => {
		const res = serviceErrToResponse(fakeCtx, new ForbiddenError("nope")) as unknown as {
			body: unknown;
			status: number;
		};
		expect(res.status).toBe(403);
		expect(res.body).toEqual({ error: "nope" });
	});

	it("maps ConflictError to 409 with the message", () => {
		const res = serviceErrToResponse(fakeCtx, new ConflictError("taken")) as unknown as {
			body: unknown;
			status: number;
		};
		expect(res.status).toBe(409);
		expect(res.body).toEqual({ error: "taken" });
	});

	it("rethrows anything that isn't a ServiceError", () => {
		expect(() => serviceErrToResponse(fakeCtx, new Error("boom"))).toThrow("boom");
	});
});

describe("mcp/error-adapter: toMcpError", () => {
	it("maps ValidationError to -32602 without leaking the issues", () => {
		const result = toMcpError(
			new ValidationError({ formErrors: ["secret internals"], fieldErrors: {} })
		);
		expect(result).toEqual({ code: -32602, message: "Invalid params" });
	});

	it("maps NotFoundError to -32000 with its client-facing message", () => {
		expect(toMcpError(new NotFoundError("Issue not found"))).toEqual({
			code: -32000,
			message: "Issue not found",
		});
	});

	it("maps ForbiddenError to -32000 with its client-facing message", () => {
		expect(toMcpError(new ForbiddenError("Not allowed"))).toEqual({
			code: -32000,
			message: "Not allowed",
		});
	});

	it("maps ConflictError to -32000 with its client-facing message", () => {
		expect(toMcpError(new ConflictError("Slug taken"))).toEqual({
			code: -32000,
			message: "Slug taken",
		});
	});

	it("maps a non-ServiceError to a generic internal error, not the raw message", () => {
		expect(toMcpError(new Error("stack trace with secrets"))).toEqual({
			code: -32000,
			message: "Internal error",
		});
	});
});
