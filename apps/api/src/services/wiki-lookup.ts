import { schema } from "@projektor/db";
import { eq, or, type SQL, sql } from "drizzle-orm";

// PROJ-812: page ids come from crypto.randomUUID() (dashed) or, for pages seeded by
// migration 0047, lower(hex(randomblob(16))) (32 hex chars, no dashes). Both shapes
// satisfy the slug pattern ^[a-z0-9-]+$, so a slug could otherwise equal another
// page's id and make an id-or-slug lookup match two rows.
const ID_SHAPED = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/;

export function isIdShapedSlug(slug: string): boolean {
	return ID_SHAPED.test(slug);
}

// WHERE fragment for "this id, or this slug". Pair it with idFirst() in orderBy so a
// row whose id matches always wins over a row whose slug happens to equal that id.
// Slugs shaped like ids are rejected on write, but pages created before PROJ-812 may
// still carry one, so the ordering is what guarantees a single, unambiguous result.
export function idOrSlugMatch(value: string): SQL {
	return or(eq(schema.wikiPages.id, value), eq(schema.wikiPages.slug, value)) as SQL;
}

export function idFirst(value: string): SQL {
	return sql`CASE WHEN ${schema.wikiPages.id} = ${value} THEN 0 ELSE 1 END`;
}
