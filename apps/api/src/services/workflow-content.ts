// Single source of truth for the canonical agent workflow spec. Consumed two ways:
// - at runtime, by getWorkflow() (services/workflow.ts) for the get_workflow MCP tool
//   and GET /api/workflow
// - at build/dev time, by scripts/gen-workflow-spec.ts, which renders this into the
//   docs-site page (apps/docs/src/content/docs/agents/workflow-spec.md); CI fails if
//   that file is stale (see .github/workflows/ci.yml), the same pattern used for the
//   MCP tool catalog.
//
// Kept as a plain TS constant (not a `?raw` markdown import) so it loads identically
// under tsx (doc-gen script), vitest, and the wrangler/esbuild release bundle — no
// bundler-specific module-loader behavior to keep in sync across three toolchains.
export const WORKFLOW_SPEC = {
	title: "Workflow spec",
	description:
		"The canonical agent workflow rules: definition of ready, state machine, human gates, WIP limits.",
	sidebarOrder: 4,
	body: `This page is the **single home** for projektor's agentic workflow rules. Every other
surface — the MCP server's \`initialize\` instructions, \`AGENTS.md\`, spawn prompts, skills —
points here instead of restating these rules. If you're reading a copy of this text
somewhere else, that copy is stale; this page wins. Fetch it programmatically any time
via the \`get_workflow\` MCP tool or \`GET /api/workflow\`.

## Definition of ready

An issue is **ready** for an agent to pick up when its body states all three of:

1. **Acceptance criteria** — a checklist or bullet list of concrete, checkable outcomes.
2. **Scope** — the files or components expected to change, named explicitly (not "the
   backend").
3. **Verification** — the exact command(s) that prove the work is done (a test file, a
   lint/type-check command, a fixture run).

\`get_prioritized_issues\` filters out issues that don't meet this bar by default. Pass
\`includeNotReady: true\` to see them anyway, tagged with \`needsGrooming: true\` and the
specific criteria missing — useful for a human doing backlog grooming, not for an agent
picking up autonomous work.

## State machine

| State | Meaning |
|---|---|
| **Backlog** | Not yet triaged into a workable slice. |
| **Ready** | Triaged (\`status: todo\`) and passes the definition of ready above. |
| **Claimed** | An agent (or human) holds a live lease via \`claim_issue\`; work is in progress. |
| **In Review** | Work is done from the implementer's side; a structured completion report is attached. |
| **Done** | Reviewed and accepted. |
| **Cancelled** | Won't do. |

## Human gates

- **Ready → Claimed**: may be fully autonomous. Any live agent session can call
  \`claim_issue\` without a human in the loop, subject to the WIP limit below.
- **In Review → Done**: may also be fully autonomous. An agent session can
  close its own (or any) issue to \`done\` directly — there's no pre-close block waiting
  on a human. An agent-worked issue still needs a completion report before it can
  close (see below). Instead of gating the transition, projektor classifies the
  report's evidence and flags weak closures for **audit after the fact** — see below.

## Completion reports

Before an agent-held issue can move into \`In Review\` or \`Done\`, it must submit a
completion report with:

- **\`summary\`** — what changed, in plain language.
- **\`verification\`** — the command(s) run and their outcome (the same ones named in
  the issue's Verification criteria).
- **\`prLink\`** *(optional)* — link to the pull request, if one exists.

\`summary\` and \`verification\` are required; if either is missing, projektor rejects the
transition and names the missing field(s). The report is recorded as a normal issue
comment, so it's visible in the same timeline as everything else.

## Evidence audit

Every agent-initiated \`done\` transition — one that passes \`agentSessionId\` for a
live agent session — has its \`completionReport.verification\` text classified:

- **Externally-verifiable** — contains a resolvable link or reference (a PR URL, a CI
  run URL, a commit URL, or a bare commit SHA) that a human (or a future automated
  check) could independently open and check. Not flagged.
- **Freeform/unverifiable** — plain prose ("manually tested", "confirmed visually")
  with nothing external to check. Flagged \`needsAudit: true\` on the issue.

This doesn't block the closure — it's audit-after-the-fact, not a gate. Pull flagged
issues for periodic review with \`list_issues({ needsAudit: true })\`. There's no
outbound verification call to GitHub or CI here (classification is pattern-based
only) — treat a resolvable link as "checkable," not "already checked."

## WIP limits

Per DORA and the ESEM work-in-progress research, there's no single "correct" WIP
limit — the right number depends on your own measured flow. Projektor enforces a
**per-project cap on concurrently agent-leased issues** (\`claim_issue\` rejects once the
cap is reached, naming the current cap and what's already held). The default is **3**,
configurable per project; treat it as a starting point to tune once \`get_flow_metrics\`
has a few weeks of real data, not a fixed rule.

## Flow metrics

\`get_flow_metrics\` reports lead time (ready → done), cycle time (claimed → done),
and WIP-over-time for a project, computed from indexed timestamps stamped the first
time an issue enters each state. Use it to decide whether the WIP limit above is too
tight, too loose, or about right — measure before you tune.
`,
} as const;
