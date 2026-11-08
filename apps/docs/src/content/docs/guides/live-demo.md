---
title: "Live demo: try Projektor before you deploy"
description: "Browse a read-only public Projektor instance running on Cloudflare Workers before you deploy your own copy."
sidebar:
  label: "Live demo"
  order: 1
---
Want to see Projektor running before you deploy your own? Visit the
[live demo](https://projektor-demo.tajdickson.workers.dev): the wiki and issue tracker
on a single Cloudflare Worker, holding a small product team's workspace.

## What's in it

- **Storefront (`SHOP`)**: a web shop's board, with a guest-checkout epic and its
  stories, bugs, and work in every state from backlog to done. Issues in review and done
  carry the completion report the agent filed when it handed the work over.
- **Mobile app (`MOB`)**: the shop's app, with a feature in progress and a task waiting
  for review.
- **Wiki**: a welcome page, the team's workflow, and a release checklist.

The content comes from a script in the Projektor repository (`scripts/demo/`) and is
reset to it with every release, so anything you see is at most one release old.

## Read-only, no login

No login is configured on the demo. It runs with `PUBLIC_READ_ONLY` enabled, so anyone
is dropped straight into a read-only viewer session instead of a Cloudflare Access
challenge. The viewer sees only projects granted to the **Public viewers** group (see
[access control](/projektor/architecture/access-control/)), which the seed script does
for both projects. You can browse everything, but creating or editing is disabled. It's
the same Worker code you'd deploy yourself, kept login-less on purpose.

When you're ready to stand up your own instance, the
[`projektor-deploy-example`](https://github.com/TAJD/projektor-deploy-example) repo is
the config-only starting point — see [Self-hosting](/projektor/guides/self-hosting/) for
the fastest path.
