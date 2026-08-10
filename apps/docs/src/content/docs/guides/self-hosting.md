---
title: "Self-hosting Projektor"
description: "Deploy your own Projektor instance on Cloudflare in five minutes."
sidebar:
  order: 1
---
Projektor deploys to **your own Cloudflare account** from a small **config-only repo**
([`projektor-deploy-example`](https://github.com/TAJD/projektor-deploy-example)) that
downloads a pre-built release artifact — no source checkout and no build step. Pick the
path that suits you; they're ordered easiest first.

Want to see it running before you deploy your own? Visit the
[live demo](https://projektor-demo.tajdickson.workers.dev).

## One click

Use the **Deploy to Cloudflare** button in the
[deploy repo](https://github.com/TAJD/projektor-deploy-example): Cloudflare clones it
into your account, **auto-provisions D1, KV, and R2**, and deploys. Fill in your admin
email on the setup page and you're live.

## One command — or one prompt

Clone the deploy repo and run the zero-config script; wrangler auto-provisions the
resources, applies migrations, and deploys:

```bash
PROJEKTOR_REPO=TAJD/projektor ADMIN_EMAILS=you@example.com ./deploy-auto.sh
```

Or hand the repo to an AI agent — *"deploy projektor to my Cloudflare account"* — and
let it run the same flow. See
[AGENT-DEPLOY.md](https://github.com/TAJD/projektor-deploy-example/blob/main/AGENT-DEPLOY.md).

## Then: configure access

The Worker is live, but **Cloudflare Access** must front it before anyone can log in
(a `*.workers.dev` toggle, or a custom domain). Then log in — the first user in
`ADMIN_EMAILS` becomes owner — and mint a token for agents. Full handoff:
[CONFIGURE.md](https://github.com/TAJD/projektor-deploy-example/blob/main/CONFIGURE.md).

**Updating later:** bump `projektor.version` and re-deploy (or push, if you wired CI).

## Manual or CI deploys

Prefer to create the resources yourself, keep your config private, or deploy from CI on
every push? The [full deploy guide](/projektor/guides/deploying/) covers the manual flow, the Cloudflare
API token recipe (it **must include D1**), and push-based auto-updates.

## Next: connect an agent

Once your instance is up, [connect an AI agent](/projektor/agents/mcp-connection/) over MCP — that's the primary
way to drive Projektor. Anything a browser user can do, an agent can do too.
