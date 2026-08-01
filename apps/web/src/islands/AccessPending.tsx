// PROJ-315: shared empty-state shown when a non-admin caller has no project
// access yet. Rendered by ProjectList, IssueList, and WikiPage in place of their
// normal empty list so the surface reads as "waiting on an admin", not "empty".
export default function AccessPending() {
	return (
		<div
			role="status"
			class="flex flex-col items-center gap-3 text-center max-w-md mx-auto py-16 px-6"
		>
			<div
				aria-hidden="true"
				class={
					"flex items-center justify-center w-12 h-12 rounded-full bg-[var(--surface)] " +
					"border border-[var(--border)] text-2xl"
				}
			>
				🔒
			</div>
			<h2 class="m-0 text-lg font-semibold text-[var(--text)]">Access pending</h2>
			<p class="m-0 text-sm text-[var(--text-muted)]">
				You’re not a member of any project group yet. Once a workspace admin adds you to a group,
				the projects, issues, and wiki pages you can access will appear here.
			</p>
		</div>
	);
}
