import type { PluginContext } from "@projektor/types";
import { NotFoundError } from "../services/errors";
import { composePlaybook } from "../services/playbook-compose";

interface MCPPromptArgument {
	name: string;
	description: string;
	required: boolean;
}

interface MCPPromptDescriptor {
	name: string;
	description: string;
	arguments: MCPPromptArgument[];
}

// Native MCP prompts/* primitive (PROJ-600) over the playbook registry, so clients
// that support it (e.g. Claude Code) surface each composable playbook as a slash
// command instead of requiring get_playbook/compose_playbook tool calls.
//
// epic-goal is the only composable playbook today (see playbook-compose.ts), so this
// list is hand-maintained rather than derived generically from PLAYBOOKS — same
// reasoning as playbook-compose.ts's dispatch: not worth building ahead of a second
// real case.
const PROMPTS: MCPPromptDescriptor[] = [
	{
		name: "epic-goal",
		description:
			"Compose a standing goal directive for autonomously working an epic (or ticket list) to completion.",
		arguments: [
			{ name: "epicRef", description: 'Epic ref, e.g. "PROJ-596"', required: true },
			{ name: "variant", description: '"bounded" (default) or "full"', required: false },
			{ name: "reviewModel", description: 'Review model name, default "opus"', required: false },
			{ name: "cadence", description: "Ticket review cadence, default 2", required: false },
		],
	},
];

export function listPrompts(): MCPPromptDescriptor[] {
	return PROMPTS;
}

export async function getPrompt(ctx: PluginContext, name: string, args: Record<string, string>) {
	const prompt = PROMPTS.find((p) => p.name === name);
	if (!prompt) {
		throw new NotFoundError(`Unknown prompt "${name}"`, { validNames: PROMPTS.map((p) => p.name) });
	}

	// MCP prompt arguments are always string-valued (clients fill a form); compose_playbook
	// expects cadence as a number and the optional fields as undefined when unset.
	const { directive } = await composePlaybook(ctx, {
		name: "epic-goal",
		params: {
			epicRef: args.epicRef,
			variant: args.variant || undefined,
			reviewModel: args.reviewModel || undefined,
			cadence: args.cadence ? Number(args.cadence) : undefined,
		},
	});

	return {
		description: prompt.description,
		messages: [
			{
				role: "user",
				content: { type: "text", text: directive },
			},
		],
	};
}
