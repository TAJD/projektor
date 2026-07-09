#!/usr/bin/env node
// Regression check for the IslandApiConvention plugin (CD-69): runs
// cofferdam against fixture.ts and diffs its own findings (ignoring
// unrelated built-in findings, which vary across cofferdam versions)
// against expected.json. Exits non-zero and prints a diff on mismatch.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `cofferdam check` exits 1 whenever it reports findings at/above the
// fail-on threshold — expected here, since the fixture exists to
// trigger findings. Only a missing/malformed stdout is a real failure.
let raw;
try {
  raw = execFileSync(
    "npx",
    [
      "--no-install",
      "cofferdam",
      "check",
      "fixtures/apps/web/src/islands/fixture.ts",
      "--config",
      "./cofferdam.toml",
      "--format",
      "json",
    ],
    { cwd: pluginDir, encoding: "utf8", shell: process.platform === "win32" },
  );
} catch (err) {
  if (typeof err.stdout !== "string" || err.stdout.length === 0) throw err;
  raw = err.stdout;
}

const actual = JSON.parse(raw).findings.filter((f) => f.id === "Warning.IslandApiConvention");
const expected = JSON.parse(readFileSync(path.join(pluginDir, "expected.json"), "utf8")).findings;

const match = JSON.stringify(actual) === JSON.stringify(expected);
if (!match) {
  console.error("Mismatch between expected.json and actual IslandApiConvention findings:");
  console.error("expected:", JSON.stringify(expected, null, 2));
  console.error("actual:  ", JSON.stringify(actual, null, 2));
  process.exit(1);
}
console.log(`OK — ${actual.length} IslandApiConvention finding(s) match expected.json`);
