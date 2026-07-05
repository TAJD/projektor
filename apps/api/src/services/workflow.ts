import { WORKFLOW_SPEC } from "./workflow-content";

export function getWorkflow() {
	return {
		title: WORKFLOW_SPEC.title,
		description: WORKFLOW_SPEC.description,
		content: WORKFLOW_SPEC.body.trim(),
	};
}
