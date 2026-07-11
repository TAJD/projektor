/**
 * Mirrors AGENTS.md (repo root) into the docs site as
 * apps/docs/src/content/docs/contributing/conventions.md.
 *
 * AGENTS.md is the source of truth - this script only prepends Starlight
 * frontmatter + a mirror note and writes the rest verbatim. CI fails if the
 * committed page has drifted from AGENTS.md (see .github/workflows/ci.yml).
 *
 *   tsx scripts/gen-conventions-page.ts
 */

// TODO: Should this be in the docs site at all? What is useful from it?

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, ".."); // scripts -> repo root
const sourcePath = join(repoRoot, "AGENTS.md");
const outPath = join(
  repoRoot,
  "apps",
  "docs",
  "src",
  "content",
  "docs",
  "contributing",
  "conventions.md",
);

const FRONTMATTER = `---
title: "Contributor conventions"
description: "Architecture contract and conventions for working on the Projektor codebase."
sidebar:
  order: 1
---
> **Note:** this page is generated from [\`AGENTS.md\`](https://github.com/TAJD/projektor/blob/main/AGENTS.md) in the repo root by \`scripts/gen-conventions-page.ts\`. Edit that file, not this page - it is overwritten on every generate.

`;

const source = readFileSync(sourcePath, "utf8");
// Drop the leading "# AGENTS.md" H1 - the docs page gets its title from frontmatter.
const body = source.replace(/^# AGENTS\.md\n+/, "");

writeFileSync(outPath, `${FRONTMATTER}${body}`, "utf8");
// cofferdam-ignore: Warning.NoConsoleLog: CLI generator script output, not a debug leftover
console.log(`Updated ${outPath} from AGENTS.md`);
