---
title: "Live demo"
description: "See Projektor running before you deploy your own instance."
sidebar:
  order: 1
---
Want to see Projektor running before you deploy your own? Check out the
[live demo](https://projektor-demo.tajdickson.workers.dev) - a fresh, unseeded instance
standing up the wiki + issue tracker on a single Cloudflare Worker.

No login is configured on the demo, so the app shell loads and then the
project/issue views get stuck on "Loading projects..." - that's expected, not broken.
The API requires Cloudflare Access, which the demo leaves unconfigured, so
`/api/projects` returns 401 and the UI never gets past the loading state. It's the same
Worker code you'd deploy yourself, just kept empty and login-less on purpose. To use
Projektor, deploy your own instance.

When you're ready to stand up your own instance, the
[`projektor-deploy-example`](https://github.com/TAJD/projektor-deploy-example) repo is
the config-only starting point - see [Self-hosting](/projektor/guides/self-hosting/) for
the fastest path.
