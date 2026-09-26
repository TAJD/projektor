-- PROJ-859: the definition-of-ready result is stored on write instead of being
-- recomputed for every open issue on every get_prioritized_issues call.
--
-- No SQL backfill: the check is a text heuristic that only exists in TypeScript
-- (services/definition-of-ready.ts). Existing rows start NULL and are filled in
-- place, in bounded batches, the first time get_prioritized_issues runs against
-- their workspace; every create/update of an issue body sets them from then on.
ALTER TABLE issues ADD COLUMN dor_ready INTEGER;
ALTER TABLE issues ADD COLUMN dor_missing TEXT;
