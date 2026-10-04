---
title: "Live demo: try Projektor before you deploy"
description: "Browse a read-only public Projektor instance running on Cloudflare Workers before you deploy your own copy."
sidebar:
  label: "Live demo"
  order: 1
---
Want to see Projektor running before you deploy your own? Visit the
[live demo](https://projektor-demo.tajdickson.workers.dev) — a fresh, unseeded instance
standing up the wiki and issue tracker on a single Cloudflare Worker.

No login is configured on the demo — it runs with `PUBLIC_READ_ONLY` enabled, so anyone
gets dropped straight into a read-only viewer session instead of a Cloudflare Access
challenge. That viewer only sees projects an admin has granted to the **Public viewers**
group (see [access control](/projektor/architecture/access-control/)); with nothing published you'll see an empty "No projects yet" list and can browse around, but creating
a project is disabled, since the read-only session has nowhere to write it. It's the same
Worker code you'd deploy yourself, kept login-less on purpose.

When you're ready to stand up your own instance, the
[`projektor-deploy-example`](https://github.com/TAJD/projektor-deploy-example) repo is
the config-only starting point — see [Self-hosting](/projektor/guides/self-hosting/) for
the fastest path.
