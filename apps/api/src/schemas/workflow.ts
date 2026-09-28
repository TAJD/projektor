import { z } from "zod";

// PROJ-933: `ifVersion` lets a caller skip re-fetching the workflow spec when they
// already hold the current content hash. Optional — an absent/mismatched value just
// returns the full spec (see services/workflow.ts).
export const GetWorkflowSchema = z.object({
	ifVersion: z.string().optional(),
});
