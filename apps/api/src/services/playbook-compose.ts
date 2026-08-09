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

function fillEpicGoalDirective(params: {
	variant: "bounded" | "full";
	reviewModel: string;
	cadence: number;
	epicTitle: string;
	epicRef: string;
	openChildCount: number;
	wipLimit: number;
}): string {
	const epicLabel = `${params.epicRef} ("${params.epicTitle}")`;
	const clauses = [
		EPIC_GOAL_TEMPLATE.goal.replace("{EPIC}", epicLabel),
		EPIC_GOAL_TEMPLATE.auditFirst,
		EPIC_GOAL_TEMPLATE.loop,
		EPIC_GOAL_TEMPLATE.selfFeed[params.variant],
		EPIC_GOAL_TEMPLATE.reviewCadence
			.replace("{N}", String(params.cadence))
			.replace("{MODEL}", params.reviewModel),
		EPIC_GOAL_TEMPLATE.doneWhen[params.variant],
		EPIC_GOAL_TEMPLATE.decisionsLog,
	];

	const liveData =
		params.openChildCount > 0
			? `**Live data:** ${params.openChildCount} open child ticket(s) on the epic; ` +
				`project agent WIP limit is ${params.wipLimit}.`
			: `**Live data:** the epic has no open child tickets yet — file some before looping; ` +
				`project agent WIP limit is ${params.wipLimit}.`;

	return [...clauses, liveData].map((c) => `> ${c}`).join(">\n");
}

export async function composePlaybook(ctx: ServiceCtx, raw: unknown) {
	const result = ComposePlaybookSchema.safeParse(raw);
	if (!result.success) throw new ValidationError(result.error.flatten());
	const { name, params } = result.data;

	const playbook = PLAYBOOKS.find((p) => p.name === name);
	if (!playbook) {
		throw new NotFoundError(`Unknown playbook "${name}"`, {
			validNames: PLAYBOOKS.map((p) => p.name),
		});
	}
	// epic-goal is the only composable playbook today; a future second playbook
	// needs its own composer branch here rather than a generic dispatch table —
	// not worth building ahead of a second real case.
	if (name !== "epic-goal") {
		throw new ValidationError({
			formErrors: [`Playbook "${name}" does not support composition`],
			fieldErrors: {},
		});
	}

	const variant = params.variant ?? DEFAULT_VARIANT;
	const reviewModel = params.reviewModel ?? DEFAULT_REVIEW_MODEL;
	const cadence = params.cadence ?? DEFAULT_CADENCE;

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
