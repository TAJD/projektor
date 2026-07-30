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
		// PROJ-484: structured conflicts (e.g. wiki's currentRevisionId + diff) are
		// spread alongside `error` so REST callers get them as plain top-level fields.
		return c.json({ error: err.message, ...(err.details ?? {}) }, 409);
	}
	if (err instanceof PayloadTooLargeError) {
		return c.json({ error: err.message }, 413);
	}
	if (err instanceof UnsupportedMediaTypeError) {
		return c.json({ error: err.message }, 415);
	}
	throw err;
}
