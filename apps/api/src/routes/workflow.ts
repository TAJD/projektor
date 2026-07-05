import type { HonoEnv } from "@projektor/types";
import { Hono } from "hono";
import { getWorkflow } from "../services/workflow";

const router = new Hono<HonoEnv>();

router.get("/", (c) => c.json(getWorkflow()));

export { router as workflowRouter };
