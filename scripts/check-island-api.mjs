#!/usr/bin/env node
// Enforce the island API convention via the IslandApiConvention cofferdam
// plugin (CD-69), replacing the retired grep-based check-island-api.sh.
//
// `cofferdam check` has no single-check filter yet (CD-74), and this repo's
// islands directory has pre-existing findings from unrelated built-in
// checks that aren't this hook's concern — so this wrapper runs the full
// scan and gates only on IslandApiConvention findings, same scope as the
// original script.

import { execFileSync } from "node:child_process";

let raw;
try {
  raw = execFileSync("npx", ["--no-install", "cofferdam", "check", "apps/web/src/islands", "--format", "json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
} catch (err) {
  if (typeof err.stdout !== "string" || err.stdout.length === 0) throw err;
  raw = err.stdout;
}

const { findings } = JSON.parse(raw);
const violations = findings.filter((f) => f.id === "Warning.IslandApiConvention");

for (const v of violations) {
  console.error(`ERROR: ${v.file}:${v.line} — ${v.message}`);
}

if (violations.length > 0) {
  console.error(`\nIsland API convention: ${violations.length} violation(s)`);
  process.exit(1);
}

console.log("Island API convention: OK");
