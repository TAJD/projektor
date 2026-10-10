const CANONICAL_ISSUE_KEY: Record<string, "id" | "issueId"> = {
	get_issue: "id",
	update_issue: "id",
	delete_issue: "id",
	list_comments: "issueId",
	add_comment: "issueId",
	update_comment: "issueId",
	delete_comment: "issueId",
	claim_issue: "issueId",
	release_issue: "issueId",
};

export function applyIssueAlias(
	tool: string,
	args: Record<string, unknown>
): { args: Record<string, unknown> } | { conflict: string } {
	const canonical = CANONICAL_ISSUE_KEY[tool];
	if (!canonical) return { args };
	const alias = canonical === "id" ? "issueId" : "id";
	if (args[alias] === undefined) return { args };
	const { [alias]: aliasValue, ...rest } = args;
	if (rest[canonical] === undefined) return { args: { ...rest, [canonical]: aliasValue } };
	if (rest[canonical] !== aliasValue) {
		return { conflict: `${canonical} and ${alias} name the same issue but differ; pass only one` };
	}
	return { args: rest };
}
