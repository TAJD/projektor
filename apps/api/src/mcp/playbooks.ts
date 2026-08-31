import type { MCPTool } from "@projektor/types";
import { ValidationError } from "../services/errors";
import { composePlaybook } from "../services/playbook-compose";
import { getPlaybook, listPlaybooks } from "../services/playbooks";

export const playbooksTools: MCPTool[] = [
	{
		name: "list_playbooks",
		description:
			"List shipped agent playbooks — generic, reusable working patterns (e.g. epic-goal). " +
			"Returns name/title/description/whenToUse for each; call get_playbook(name) for the full body.",
		inputSchema: {
			type: "object",
			properties: {},
		},
		async handler() {
			return listPlaybooks();
		},
	},
	{
		name: "get_playbook",
		description: "Fetch a shipped playbook's full content by name.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: 'Playbook name, e.g. "epic-goal"' },
			},
			required: ["name"],
		},
		async handler(input) {
			const { name } = input as { name?: unknown };
			if (!name || typeof name !== "string") {
				throw new ValidationError({ formErrors: ["name is required"], fieldErrors: {} });
			}
			return getPlaybook(name);
		},
	},
	{
		name: "compose_playbook",
		description:
			"Fill a playbook template server-side using live project data (epic title, open child " +
			'count, agent WIP limit). For "epic-goal": params.epicRef is required; ' +
			'params.variant (bounded|full, default bounded), params.reviewModel (default "opus"), ' +
			"params.cadence (default 2) are optional.",
		inputSchema: {
			type: "object",
			properties: {
				name: { type: "string", description: 'Playbook name, e.g. "epic-goal"' },
				params: {
					type: "object",
					properties: {
						epicRef: { type: "string", description: 'Epic ref, e.g. "PROJ-596"' },
						variant: { type: "string", enum: ["bounded", "full"] },
						reviewModel: { type: "string" },
						cadence: { type: "integer", minimum: 1 },
					},
					required: ["epicRef"],
				},
			},
			required: ["name", "params"],
		},
		async handler(input, ctx) {
			return composePlaybook(ctx, input);
		},
	},
];
