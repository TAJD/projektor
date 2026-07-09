// Cloudflare D1 rejects any query carrying more than 100 bound parameters. A query
// whose parameter count grows with an input array — drizzle `inArray`, a raw `IN (...)`,
// or a batched mutation keyed by ids — will therefore throw at runtime once the array is
// large enough (manifesting as a 500). The boundary is invisible in tests: the vitest
// runner backs D1 with SQLite, whose limit is 32766, so an un-chunked query passes CI and
// only fails on real D1.
// RULE: never bind a row- or user-scaled array straight into a query. Split it with
// `inChunks` so each underlying query stays under the cap.
const D1_BOUND_PARAM_LIMIT = 100;

// Conservative chunk size: leaves ~10 parameters of headroom for the other predicates in
// the same query (a workspaceId filter, status filters, etc.). Every current caller binds
// fewer than 10 extra params, so 90 is safe; shrink it if a query ever needs more.
const CHUNK_SIZE = D1_BOUND_PARAM_LIMIT - 10;

/**
 * Run `op` over `items` in chunks small enough that each resulting query stays under D1's
 * bound-parameter cap, concatenating the rows each chunk returns. For mutations that
 * return nothing, have `op` return an empty array.
 */
export async function inChunks<I, O>(
	items: readonly I[],
	op: (chunk: I[]) => Promise<O[]>
): Promise<O[]> {
	if (items.length === 0) return [];
	const out: O[] = [];
	for (let i = 0; i < items.length; i += CHUNK_SIZE) {
		out.push(...(await op(items.slice(i, i + CHUNK_SIZE) as I[])));
	}
	return out;
}
