---
title: "Your first ten minutes"
description: "Deploy an instance, connect an agent, and get it doing real work — the shortest path from zero to a working setup."
sidebar:
  order: 0
---
The other guides go deep on each step. This page is the narrow path through all of
them: deploy, log in, connect an agent, and give it something to do.

## 1. Deploy (about 3 minutes)

Click **Deploy to Cloudflare** in the
[deploy repo](https://github.com/TAJD/projektor-deploy-example): it clones into your
account, auto-provisions D1, KV, and R2, and ships. Fill in your admin email on the
setup page. Full detail, including the one-command and manual/CI paths, is in the
[self-hosting guide](/projektor/guides/self-hosting/).

## 2. Front it with Cloudflare Access and log in (about 3 minutes)

The Worker is live but nobody can reach it yet — **Cloudflare Access** has to sit in
front before login works (a `*.workers.dev` toggle, or a custom domain). Turn that on,
then log in with any address in `ADMIN_EMAILS`: the first one to log in creates the
default workspace and becomes its owner automatically. Step-by-step:
[CONFIGURE.md](https://github.com/TAJD/projektor-deploy-example/blob/main/CONFIGURE.md).

## 3. Connect Claude (about 2 minutes)

Open **Connect Agent** in the sidebar and copy the server URL
(`https://<your-host>/mcp/<workspace-id>`). In the Claude app or on claude.ai, add it as a
custom connector and sign in; in Claude Code, run
`claude mcp add --transport http projektor "<server URL>"`, then `/mcp` to sign in.

Behind Cloudflare Access, sign-in only works once the OAuth paths are exempt from Access:
see [Deploying → Cloudflare Access carve-outs for OAuth](/projektor/guides/deploying/#6-cloudflare-access-carve-outs-for-oauth).
An instance from the one-click deploy button can't use sign-in yet, so use a workspace API
token there. Every option, including headless agents and what to do when it fails, is on
one page: [Connect Claude](/projektor/agents/mcp-connection/).

## 4. Give it something to do

Try one of these directly in your agent's chat:

> "Create an issue: 'Set up CI' with high priority."
>
> "Show me the highest-priority open issues in this project."
>
> "Write a wiki page describing this project, and link it from the homepage."

If the agent can do all three, the connection is working end to end. From here:

- **Understand why it's built this way:** [Agentic workflows](/projektor/agents/agent-workflows/)
- **See every tool it has:** [MCP tool catalog](/projektor/agents/tool-catalog/)
- **Run a fleet of agents on one repo:** [Contributor conventions](/projektor/contributing/conventions/)
