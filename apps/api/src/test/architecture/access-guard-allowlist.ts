// PROJ-837: exceptions to the access-guard architecture test.
//
// Each key is "<service file>:<exported function>" for a function that takes a
// project-scoped id but deliberately does not reach services/access.ts. Every entry
// needs a reason a security reviewer would accept. This file is owned via CODEOWNERS —
// adding an entry is a security decision, not a way to get CI green.
export const ACCESS_GUARD_ALLOWLIST: Record<string, string> = {
	"groups:removeGroupGrant":
		"Workspace owner/admin only (requireAdmin); admins bypass project access by design, and the group is workspace-checked.",
	"projects:deleteProject":
		"Workspace owner only; owners bypass project access by design. Delete is scoped by workspace_id.",
	"projects:updateProject":
		"Workspace owner/admin only (member/viewer rejected up front); admins bypass project access by design.",
	"issue-leases:readAgentWorkFlags":
		"PROJ-1059: replaces the issueHasLiveAgentLease/issueEverHadAgentLease probes. Internal boolean probe for updateIssue's review/done gating; started alongside updateIssue's guarded issue load and read only after that guard passes. Workspace-scoped and returns no issue data.",
	"issue-leases:buildReleaseLeaseForClosedIssueStatement":
		"PROJ-928: internal cleanup called from updateIssue only after that call's own access guard already authorized the status change; workspace-scoped write, returns no issue data.",
	"file-claims:buildReleaseClaimsForClosedIssueStatement":
		"PROJ-928: same as issue-leases:buildReleaseLeaseForClosedIssueStatement — internal cleanup called from updateIssue post-guard; workspace-scoped write, returns no issue data.",
};
