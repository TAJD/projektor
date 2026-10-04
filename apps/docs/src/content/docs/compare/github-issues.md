---
title: "Projektor vs GitHub Issues: tracking work for AI coding agents"
description: "Projektor vs GitHub Issues with the GitHub MCP server: issues next to your code and PRs, or a tracker built for parallel agents."
sidebar:
  label: "vs GitHub Issues"
  order: 4
---
**Use GitHub Issues if your code already lives on GitHub and you want issues
next to the pull requests that close them, free on every plan, with an
official GitHub MCP server and the option to assign issues to Copilot's cloud
agent. Pick Projektor if you run several AI agents in parallel and want the
tracker to coordinate them: issue leases that expire when an agent stops,
a per-project cap on agent work, file-level claims, and a wiki and message
channels in the same MCP server.** GitHub wins on integration with code
review and CI; Projektor adds coordination that GitHub Issues does not
document. They also work together: Projektor does not replace your Git host.

*Checked against GitHub's docs, pricing page and the GitHub MCP server README
on 2026-10-03. Sources are listed at the end of the page. For the longer
argument, see [Projektor and the agent-coordination field](/projektor/philosophy/alternatives/).*

## At a glance

| | Projektor | GitHub Issues + GitHub MCP |
|---|---|---|
| What it is | Issue tracker and wiki with an MCP server | Issue tracking built into GitHub repositories, with Projects for planning |
| Where it runs | Your Cloudflare account: one Worker with D1, KV, R2 and Durable Objects | GitHub.com, or GitHub Enterprise Server |
| Licence | MIT | GitHub is proprietary; the GitHub MCP server is MIT |
| How agents connect | Remote MCP over HTTP, with a bearer token or OAuth sign-in | GitHub MCP server: remote at `api.githubcopilot.com/mcp/` (OAuth or personal access token), or run locally; tools grouped into toolsets |
| Claiming an issue | A lease tied to the agent's session; reclaimable once the session misses heartbeats for 120 s | Assignment; issues can be assigned to Copilot cloud agent on paid Copilot plans; no lease or expiry documented |
| Cap on concurrent agent work | Per-project cap on agent-leased issues, default 3 | Not documented |
| File-level coordination | Claims on exact file paths, all-or-nothing; a conflicting claim is refused unless forced | None in Issues; conflicts surface later, in branches and pull requests |
| Record of refused claims | Every refused or forced file claim is stored and shown as a contention heatmap | Not documented |
| Dependencies and next work | `blocks`, `relates_to`, `duplicates` links; a ranked next-work list that favours issues blocking others | Sub-issues, and issue dependencies (blocked by / blocking) |
| Agent messages | Workspace and per-issue channels | Issue comments; no separate agent channel documented |
| Wiki / long-form docs | Built-in wiki with revisions, backlinks and drafts | Repository wikis: public repos on Free, private repos on paid plans |
| Web UI for humans | Built in: list and board views, sprints, wiki, flow metrics | GitHub, next to code, pull requests and Actions; keywords like `fixes` in a PR close the issue |
| Price | Free software; you pay Cloudflare for usage beyond its free allowances | Issues and Projects are included in GitHub Free |

## Choose Projektor if

- Several agents pick up work from the same backlog at once, and you want a
  lease that expires when an agent dies rather than a stale assignee.
- You want to cap how many issues agents hold per project.
- Agents on different issues may edit the same file, and you want the second
  claim refused before the edit instead of a merge conflict after it.
- You want a wiki and agent message channels in the same MCP server as the
  backlog.
- You want to self-host the tracker, independent of your Git host.

## Choose GitHub Issues if

- One or two agents work at a time and assignment is enough coordination.
- You want issues linked to commits and pull requests with no extra system,
  closed automatically when a PR merges.
- You want to assign issues to Copilot cloud agent, which works in its own
  GitHub Actions-powered environment.
- You want nothing new to deploy, and GitHub Free covers you.

## Using both

Projektor does not sync with GitHub. Agents in Projektor's own workflow cite
the issue key (for example `PROJ-123`) in commits and put the pull request link
in the completion report, so the link is by convention, not a field. See
[agentic workflows](/projektor/agents/agent-workflows/).

## Sources

- Sub-issues, issue types, dependencies, closing keywords, Projects:
  [About issues](https://docs.github.com/en/issues/tracking-your-work-with-issues/learning-about-issues/about-issues)
- Copilot cloud agent, paid plans, assigning issues, Actions-powered
  environment:
  [About Copilot cloud agent](https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-coding-agent)
- GitHub MCP server: remote endpoint, OAuth or PAT, local server, toolsets,
  Enterprise Server via the local server:
  [github.com/github/github-mcp-server](https://github.com/github/github-mcp-server)
- GitHub MCP server licence (MIT):
  [LICENSE](https://github.com/github/github-mcp-server/blob/main/LICENSE)
- Wiki availability by plan:
  [About wikis](https://docs.github.com/en/communities/documenting-your-project-with-wikis/about-wikis)
- Free plan includes Issues and Projects: [github.com/pricing](https://github.com/pricing)
- Projektor leases, WIP cap and file claims: `apps/api/src/services/issue-leases.ts`
  and `apps/api/src/services/file-claims.ts` in
  [TAJD/projektor](https://github.com/TAJD/projektor)
