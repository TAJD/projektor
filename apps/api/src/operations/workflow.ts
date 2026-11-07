import { GetWorkflowSchema } from "../schemas/workflow";
import { getWorkflow } from "../services/workflow";
import { defineOperation } from "./define";

export const workflowOperations = [
	defineOperation({
		id: "get_workflow",
		method: "GET",
		path: "/api/workflow",
		domain: "workflow",
		tier: "read",
		workspace: false,
		keywords: ["process", "definition of ready", "state machine", "gates", "wip limits", "rules"],
		summary:
			"Fetch the canonical agent workflow spec: definition of ready, state machine, human gates, " +
			"completion report requirements, and WIP limits. Call this before claiming work. Returns a " +
			"content `version` (a stable hash — unchanged unless the spec content changes). Pass a " +
			"previously-returned version back as `ifVersion` to skip re-reading an unchanged spec: a " +
			"match returns just `{ unchanged: true, version }` instead of the full content.",
		input: GetWorkflowSchema,
		run: (_ctx, input) => getWorkflow(input),
	}),
];
