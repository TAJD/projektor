import { describe, it } from "vitest";

// Scaffold for DELETE /workspaces/:slug — implement once PROJ-96 lands the route.
//
// Expected behaviour:
//   204 No Content   — workspace deleted successfully; memberships and tokens cascade
//   403 Forbidden    — slug matches DEFAULT_WORKSPACE_SLUG (the seed workspace is undeletable)
//   403 Forbidden    — caller's role is not "owner" for that workspace
//   404 Not Found    — slug does not match any workspace
//   409 Conflict     — workspace still has projects (caller must delete projects first)

describe("DELETE /workspaces/:slug (PROJ-96)", () => {
	it.todo("returns 204 and removes the workspace on success");
	it.todo("returns 403 when attempting to delete DEFAULT_WORKSPACE_SLUG");
	it.todo("returns 403 when caller is not an owner of the workspace");
	it.todo("returns 404 when the workspace slug does not exist");
	it.todo("returns 409 when the workspace still has projects");
});
