# Security Policy

## Reporting a vulnerability

Please report security issues **privately** - do not open a public issue.

Email the maintainer directly at **tajdickson@protonmail.com** with:

- a description of the vulnerability and its impact,
- steps to reproduce (a proof of concept if you have one),
- the affected version or commit.

You'll get an acknowledgement, and a fix or mitigation will be prioritised over
other work. Please give a reasonable window to address the issue before any
public disclosure.

## Scope

projektor is a self-hosted application: each deployment runs on the operator's
own Cloudflare account, behind their own Cloudflare Access configuration. Reports
about the projektor codebase itself are in scope; misconfiguration of an
individual deployment (e.g. a missing Access policy) is the operator's
responsibility - see [CONFIGURE.md in the deploy repo](https://github.com/TAJD/projektor-deploy-example/blob/main/CONFIGURE.md).
