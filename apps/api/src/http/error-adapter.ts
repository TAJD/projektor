import type { HonoEnv } from "@projektor/types";
import type { Context } from "hono";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../services/errors";

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
	throw err;
}
