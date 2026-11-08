/**
 * Writes the OpenAPI 3.1 spec and the operation search index from the operation
 * registry (apps/api/src/operations). CI runs this and fails if either committed
 * file is stale (see .github/workflows/ci.yml).
 *
 *   pnpm --filter @projektor/api gen:openapi
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildOpenApi, buildSearchIndex } from "../src/openapi";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "..", "docs", "src", "generated");
mkdirSync(outDir, { recursive: true });

const spec = `${JSON.stringify(buildOpenApi(), null, "\t")}\n`;
const index = `${JSON.stringify(buildSearchIndex())}\n`;
writeFileSync(join(outDir, "openapi.json"), spec);
writeFileSync(join(outDir, "search-index.json"), index);
console.log(
	`openapi.json ${(spec.length / 1024).toFixed(1)} KB, search-index.json ${(index.length / 1024).toFixed(1)} KB`
);
