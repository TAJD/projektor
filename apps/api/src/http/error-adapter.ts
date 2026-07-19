import type { HonoEnv } from "@projektor/types";
import type { Context } from "hono";
import {
	ConflictError,
	ForbiddenError,
	NotFoundError,
	PayloadTooLargeError,
	UnsupportedMediaTypeError,
	ValidationError,
} from "../services/errors";

export function serviceErrToResponse(c: Context<HonoEnv>, err: unknown) {
	if (err instanceof ValidationError) {
		return c.json({ error: err.issues }, 400);
	}
	if (err instanceof NotFoundError) {
		return c.json({ error: err.message }, 404);
	}
	if (err instanceof ForbiddenError) {
		return c.json({ error: err.message }, 403);
	}
	if (err instanceof ConflictError) {
		return c.json({ error: err.message }, 409);
	}
	if (err instanceof PayloadTooLargeError) {
		return c.json({ error: err.message }, 413);
	}
	if (err instanceof UnsupportedMediaTypeError) {
		return c.json({ error: err.message }, 415);
	}
	throw err;
}
