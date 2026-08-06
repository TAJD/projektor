---
title: "Live demo"
description: "See Projektor running before you deploy your own instance."
sidebar:
  order: 1
---
Want to see Projektor running before you deploy your own? Visit the
[live demo](https://projektor-demo.tajdickson.workers.dev) - a fresh, unseeded instance
standing up the wiki and issue tracker on a single Cloudflare Worker.

No login is configured on the demo - it runs with `PUBLIC_READ_ONLY` enabled (PROJ-373),
so anyone gets dropped straight into a read-only viewer session instead of a Cloudflare
Access challenge. You'll see an empty "No projects yet" list and can browse around, but
creating projects, issues, or wiki pages is disabled - that's expected, not broken. It's
the same Worker code you'd deploy yourself, kept empty and login-less on purpose. To use
Projektor, deploy your own instance.

When you're ready to stand up your own instance, the
[`projektor-deploy-example`](https://github.com/TAJD/projektor-deploy-example) repo is
the config-only starting point - see [Self-hosting](/projektor/guides/self-hosting/) for
the fastest path.
