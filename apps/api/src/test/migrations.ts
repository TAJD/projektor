// Static ?raw imports — Vite inlines each file as a string literal at bundle time.
// Add a new import here whenever a migration is added to packages/db/migrations/.
import m0000 from "../../../../packages/db/migrations/0000_tidy_jigsaw.sql?raw";
import m0001 from "../../../../packages/db/migrations/0001_attachments.sql?raw";
import m0002 from "../../../../packages/db/migrations/0002_issue_number_unique.sql?raw";
import m0003 from "../../../../packages/db/migrations/0003_issue_parent_id.sql?raw";
import m0004 from "../../../../packages/db/migrations/0004_task_types.sql?raw";
import m0005 from "../../../../packages/db/migrations/0005_missing_indexes.sql?raw";
import m0006 from "../../../../packages/db/migrations/0006_rate_limit.sql?raw";
import m0007 from "../../../../packages/db/migrations/0007_issue_fts.sql?raw";
import m0008 from "../../../../packages/db/migrations/0008_issue_links.sql?raw";
import m0009 from "../../../../packages/db/migrations/0009_task_statuses.sql?raw";
import m0010 from "../../../../packages/db/migrations/0010_custom_fields.sql?raw";
import m0011 from "../../../../packages/db/migrations/0011_status_category.sql?raw";
import m0012 from "../../../../packages/db/migrations/0012_task_type_backfill.sql?raw";
import m0013 from "../../../../packages/db/migrations/0013_sprints.sql?raw";
import m0014 from "../../../../packages/db/migrations/0014_user_scoped_tokens.sql?raw";
import m0015 from "../../../../packages/db/migrations/0015_wiki_project_scope.sql?raw";
import m0016 from "../../../../packages/db/migrations/0016_seed_missing_task_types.sql?raw";
import m0017 from "../../../../packages/db/migrations/0017_share_tokens.sql?raw";
import m0018 from "../../../../packages/db/migrations/0018_agent_sessions.sql?raw";
import m0019 from "../../../../packages/db/migrations/0019_issue_file_claims.sql?raw";
import m0020 from "../../../../packages/db/migrations/0020_agent_messages.sql?raw";
import m0021 from "../../../../packages/db/migrations/0021_issue_leases.sql?raw";

export const MIGRATIONS = [
	m0000,
	m0001,
	m0002,
	m0003,
	m0004,
	m0005,
	m0006,
	m0007,
	m0008,
	m0009,
	m0010,
	m0011,
	m0012,
	m0013,
	m0014,
	m0015,
	m0016,
	m0017,
	m0018,
	m0019,
	m0020,
	m0021,
];
