import { drizzle, schema } from "@projektor/db";
import { ComposePlaybookSchema } from "../schemas/playbooks";
import { NotFoundError, ValidationError } from "./errors";
import { fetchAgentWipCap } from "./issue-leases";
import { getIssue } from "./issues";
import { EPIC_GOAL_TEMPLATE, PLAYBOOKS } from "./playbook-content";
import type { ServiceCtx } from "./types";

const DEFAULT_VARIANT = "bounded";
const DEFAULT_REVIEW_MODEL = "opus";
const DEFAULT_CADENCE = 2;
const DEFAULT_CHECKPOINT_INTERVAL = 10;

function fillEpicGoalDirective(params: {
	variant: "bounded" | "full";
	reviewModel: string;
	cadence: number;
	checkpointInterval: number;
	epicTitle: string;
	epicRef: string;
	openChildCount: number;
	wipLimit: number;
}): string {
	// Plain split/join instead of String.replace: replace's *replacement* string
	// treats "$&", "$`", "$'", "$$" as special patterns, so a caller-controlled
	// epic title or review model containing e.g. "$'" would silently corrupt the
	// directive.
	const fill = (template: string, placeholder: string, value: string) =>
		template.split(placeholder).join(value);

	const epicLabel = `${params.epicRef} ("${params.epicTitle}")`;
	const clauses = [
		fill(EPIC_GOAL_TEMPLATE.goal, "{EPIC}", epicLabel),
		EPIC_GOAL_TEMPLATE.auditFirst,
		EPIC_GOAL_TEMPLATE.loop,
		EPIC_GOAL_TEMPLATE.selfFeed[params.variant],
		fill(
			fill(EPIC_GOAL_TEMPLATE.reviewCadence, "{N}", String(params.cadence)),
			"{MODEL}",
			params.reviewModel
		),
		fill(
			EPIC_GOAL_TEMPLATE.humanCheckpoint,
			"{CHECKPOINT_INTERVAL}",
			String(params.checkpointInterval)
		),
		EPIC_GOAL_TEMPLATE.doneWhen[params.variant],
		EPIC_GOAL_TEMPLATE.decisionsLog,
	];

	const liveData =
		params.openChildCount > 0
			? `**Live data:** ${params.openChildCount} open child ticket(s) on the epic; ` +
				`project agent WIP limit is ${params.wipLimit}.`
			: `**Live data:** the epic has no open child tickets yet — file some before looping; ` +
				`project agent WIP limit is ${params.wipLimit}.`;

	return [...clauses, liveData].map((c) => `> ${c}`).join("\n>\n");
}

export async function composePlaybook(ctx: ServiceCtx, raw: unknown) {
	const result = ComposePlaybookSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { name, params } = result.data;

	// epic-goal is the only composable playbook today; a future second playbook
	// needs its own composer branch here rather than a generic dispatch table —
	// not worth building ahead of a second real case.
	const playbook = PLAYBOOKS.find((p) => p.name === name && name === "epic-goal");
	if (!playbook) {
		throw new NotFoundError(`Unknown or non-composable playbook "${name}"`, {
			validNames: PLAYBOOKS.filter((p) => p.name === "epic-goal").map((p) => p.name),
		});
	}

	const variant = params.variant ?? DEFAULT_VARIANT;
	const reviewModel = params.reviewModel ?? DEFAULT_REVIEW_MODEL;
	const cadence = params.cadence ?? DEFAULT_CADENCE;
	const checkpointInterval = params.checkpointInterval ?? DEFAULT_CHECKPOINT_INTERVAL;

	const issue = (await getIssue(ctx, { ref: params.epicRef })) as {
		title: string;
		project_id: string;
		project_key: string;
		number: number;
		rollup: { remaining: number };
	};

	const orm = drizzle(ctx.db, { schema });
	const wipLimit = await fetchAgentWipCap(orm, ctx, issue.project_id);

	const directive = fillEpicGoalDirective({
		variant,
		reviewModel,
		cadence,
		checkpointInterval,
		epicTitle: issue.title,
		epicRef: `${issue.project_key}-${issue.number}`,
		openChildCount: issue.rollup.remaining,
		wipLimit,
	});

	return {
		name: playbook.name,
		variant,
		directive,
	};
}
