-- PROJ-396: issue author kind, same convention as issue_comments.author_kind (0029,
-- PROJ-328) — stamped from the authenticated principal type at write time (Cloudflare
-- Access JWT => human, Bearer API token => agent — see middleware/auth.ts). NULL for
-- issues created before this column existed; there's no reliable signal to backfill
-- principal type for those, so they're excluded from human/agent breakdowns rather
-- than guessed.
ALTER TABLE issues ADD COLUMN author_kind TEXT;
