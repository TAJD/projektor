import type { HonoEnv } from "@projektor/types";
import type { Context } from "hono";
import { ValidationError } from "../services/errors";

/**
 * PROJ-877: the one way routes read a JSON body. `c.req.json()` throws a SyntaxError
 * on malformed input, which used to surface as a 500; this turns it into the standard
 * 400 validation shape (via serviceErrToResponse, or app.onError for calls outside a
 * route's try).
 */
// Same `any` as c.req.json() so call sites that spread the body keep compiling; every
// consumer validates it with the service's Zod schema.
// biome-ignore lint/suspicious/noExplicitAny: mirrors c.req.json(); validated downstream
export async function jsonBody(c: Context<HonoEnv>): Promise<any> {
	try {
		return await c.req.json();
	} catch {
		throw new ValidationError({ formErrors: ["Request body must be valid JSON"], fieldErrors: {} });
	}
}
