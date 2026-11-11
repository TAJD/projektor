// Allowlist for in-array-chunking.node.test.ts: `inArray` calls in services that are
// not lexically inside an `inChunks` callback and don't take a fixed array literal.
// Key: "<service file>#<enclosing top-level function>". The value says why the bound
// parameter count cannot reach D1's 100-parameter cap. Re-check the reason whenever
// the function's inputs change.
export const IN_ARRAY_CHUNKING_ALLOWLIST: Record<string, string> = {
	"file-claims.ts#buildReleaseByIdsStatements":
		"chunked by hand with chunk(ids, ID_CHUNK_SIZE), one statement per chunk",
	"file-claims.ts#heldByCaller": "the second argument is a subquery, not a bound array",
	"file-claims.ts#releaseFiles":
		"selectClaims is only called with a chunk from inChunks, or with no paths at all",
	"issue-links.ts#prepareNewIssueLinks":
		"links is capped at 50 by CreateIssueSchema, plus one workspace parameter",
	"issues.ts#addStatusFilters":
		"statusIds is capped by MAX_STATUS_IDS_FILTER; priorities is filtered to the five known values and de-duplicated",
	"wiki.ts#deleteWikiPageAttachments":
		"its only caller passes a chunk from inChunks; each query adds at most three other parameters",
};
