import type { MCPTool } from "@projektor/types";
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
			const { name } = input as { name: string };
			return getPlaybook(name);
		},
	},
];
