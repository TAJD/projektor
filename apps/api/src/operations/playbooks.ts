import { z } from "zod";
import { PLAIN_WRITE } from "../mcp/annotations";
import { ComposePlaybookSchema, GetPlaybookSchema } from "../schemas/playbooks";
import { composePlaybook } from "../services/playbook-compose";
import { getPlaybook, listPlaybooks } from "../services/playbooks";
import { defineOperation } from "./define";

const base = {
	domain: "playbooks",
	keywords: ["playbook", "recipe", "pattern", "epic-goal", "how to", "template"],
};

export const playbookOperations = [
	defineOperation({
		...base,
		id: "list_playbooks",
		method: "GET",
		path: "/api/playbooks",
		tier: "read",
		workspace: false,
		summary:
			"List shipped agent playbooks — generic, reusable working patterns (e.g. epic-goal). " +
			"Returns name/title/description/whenToUse for each; call get_playbook(name) for the full body.",
		input: z.object({}),
		run: async () => listPlaybooks(),
	}),
	defineOperation({
		...base,
		id: "get_playbook",
		method: "GET",
		path: "/api/playbooks/:name",
		tier: "read",
		workspace: false,
		summary: "Fetch a shipped playbook's full content by name.",
		input: GetPlaybookSchema,
		run: async (_ctx, { name }) => getPlaybook(name),
	}),
	defineOperation({
		...base,
		id: "compose_playbook",
		method: "POST",
		path: "/api/playbooks/:name/compose",
		tier: "write",
		annotations: PLAIN_WRITE,
		bodyKey: "params",
		summary:
			"Fill a playbook template server-side using live project data (epic title, open child " +
			'count, agent WIP limit). For "epic-goal": params.epicRef is required; ' +
			'params.variant (bounded|full, default bounded), params.reviewModel (default "opus"), ' +
			"params.cadence (default 2) are optional.",
		input: ComposePlaybookSchema,
		run: (ctx, input) => composePlaybook(ctx, input),
	}),
];
