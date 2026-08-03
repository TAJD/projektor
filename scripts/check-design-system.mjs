#!/usr/bin/env node
// Enforce the design-system convention via the DesignSystemConvention cofferdam
// plugin (PROJ-527/PROJ-559) — no raw color literals, respect component import
// boundaries, no new ad-hoc primitive-shaped CSS classes, no inline token-shaped
// styles.
//
// `cofferdam check` has no single-check filter yet (CD-74), and this repo's
// apps/web/src has pre-existing findings from unrelated built-in checks that
// aren't this hook's concern — so this wrapper runs the full scan and gates
// only on DesignSystemConvention findings, mirroring check-island-api.mjs.

import { execFileSync } from "node:child_process";

let raw;
try {
  raw = execFileSync("npx", ["--no-install", "cofferdam", "check", "apps/web/src", "--format", "json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
} catch (err) {
  if (typeof err.stdout !== "string" || err.stdout.length === 0) throw err;
  raw = err.stdout;
}

const { findings } = JSON.parse(raw);
const violations = findings.filter((f) => f.id === "Warning.DesignSystemConvention");

for (const v of violations) {
  console.error(`ERROR: ${v.file}:${v.line} — ${v.message}`);
}

if (violations.length > 0) {
  console.error(`\nDesign system convention: ${violations.length} violation(s)`);
  process.exit(1);
}

console.log("Design system convention: OK");
