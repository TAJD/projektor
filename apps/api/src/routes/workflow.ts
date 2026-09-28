import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { serviceErrToResponse } from "../http/error-adapter";
import { getWorkflow } from "../services/workflow";

const router = new Hono<HonoEnv>();

router.get("/", async (c) => {
	try {
		// Normally a single string; a repeated `?ifVersion=` is passed through as an
		// array so the service's Zod schema rejects it as an invalid type (400), the
		// same as MCP's `ifVersion` failing to type-check as a string.
		const ifVersionValues = c.req.queries("ifVersion");
		const ifVersion =
			ifVersionValues === undefined
				? undefined
				: ifVersionValues.length === 1
					? ifVersionValues[0]
					: ifVersionValues;
		return c.json(await getWorkflow({ ifVersion }));
	} catch (e) {
		return serviceErrToResponse(c, e);
	}
});

export { router as workflowRouter };
