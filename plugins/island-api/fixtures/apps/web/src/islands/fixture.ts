// fixture.ts — input to `cofferdam check` for the IslandApiConvention
// plugin (CD-69). Comments label the expected outcome on each line.
// The plugin should emit FOUR issues total:
//   - FLAG buildHeaders (function form)
//   - FLAG buildHeaders (const/arrow form — not AST-visible, see CD-78)
//   - FLAG bare fetch()
//   - FLAG window.fetch()

function withFunctionBuildHeaders() {
  function buildHeaders(token: string): Record<string, string> { // FLAG buildHeaders (function form)
    return { Authorization: `Bearer ${token}` };
  }
  return buildHeaders("token");
}

function withConstBuildHeaders() {
  const buildHeaders = (token: string) => ({ Authorization: token }); // FLAG buildHeaders (const form)
  return buildHeaders("token");
}

declare function apiFetch(url: string): Promise<unknown>;
declare const someClient: { fetch(url: string): Promise<unknown> };

export async function loadIssue(id: string) {
  const a = await fetch(`/api/issues/${id}`); // FLAG bare fetch()
  const b = await window.fetch(`/api/issues/${id}`); // FLAG window.fetch()
  const c = await apiFetch(`/api/issues/${id}`); // OK (approved wrapper)
  const d = await someClient.fetch(`/api/issues/${id}`); // OK (non-global object)
  return { a, b, c, d };
}
