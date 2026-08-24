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
import m0022 from "../../../../packages/db/migrations/0022_issue_completed_at.sql?raw";
import m0023 from "../../../../packages/db/migrations/0023_issue_flow_timestamps.sql?raw";
import m0024 from "../../../../packages/db/migrations/0024_project_agent_wip_limit.sql?raw";
import m0025 from "../../../../packages/db/migrations/0025_issue_completion_report.sql?raw";
import m0026 from "../../../../packages/db/migrations/0026_backfill_flow_timestamps.sql?raw";
import m0027 from "../../../../packages/db/migrations/0027_user_groups.sql?raw";
import m0028 from "../../../../packages/db/migrations/0028_downgrade_viewer_grants.sql?raw";
import m0029 from "../../../../packages/db/migrations/0029_issue_review_timestamp.sql?raw";
import m0030 from "../../../../packages/db/migrations/0030_backfill_review_timestamp.sql?raw";
import m0031 from "../../../../packages/db/migrations/0031_factory_health.sql?raw";
import m0032 from "../../../../packages/db/migrations/0032_claim_conflicts.sql?raw";
import m0033 from "../../../../packages/db/migrations/0033_custom_field_is_internal.sql?raw";
import m0034 from "../../../../packages/db/migrations/0034_issue_needs_audit.sql?raw";
import m0035 from "../../../../packages/db/migrations/0035_project_slug.sql?raw";
import m0036 from "../../../../packages/db/migrations/0036_feedback.sql?raw";
import m0037 from "../../../../packages/db/migrations/0037_issue_author_kind.sql?raw";
import m0038 from "../../../../packages/db/migrations/0038_attachment_kinds.sql?raw";
import m0039 from "../../../../packages/db/migrations/0039_wip_cap_denials.sql?raw";
import m0040 from "../../../../packages/db/migrations/0040_provisioning_removals.sql?raw";
import m0041 from "../../../../packages/db/migrations/0041_wiki_slug_unique.sql?raw";
import m0042 from "../../../../packages/db/migrations/0042_wiki_revision_title_summary.sql?raw";
import m0043 from "../../../../packages/db/migrations/0043_wiki_fts.sql?raw";
import m0044 from "../../../../packages/db/migrations/0044_wiki_links.sql?raw";
import m0045 from "../../../../packages/db/migrations/0045_wiki_frontmatter.sql?raw";
import m0046 from "../../../../packages/db/migrations/0046_wiki_page_templates.sql?raw";
import m0047 from "../../../../packages/db/migrations/0047_seed_wiki_templates.sql?raw";
import m0048 from "../../../../packages/db/migrations/0048_wiki_watchers.sql?raw";
import m0049 from "../../../../packages/db/migrations/0049_wiki_drafts.sql?raw";
import m0050 from "../../../../packages/db/migrations/0050_wiki_slug_slash_backfill.sql?raw";
import m0051 from "../../../../packages/db/migrations/0051_wiki_trash.sql?raw";
import m0052 from "../../../../packages/db/migrations/0052_wiki_trash_batch_id.sql?raw";
import m0053 from "../../../../packages/db/migrations/0053_backfill_templates_page_fts.sql?raw";
import m0054 from "../../../../packages/db/migrations/0054_project_archived_at.sql?raw";

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
	m0022,
	m0023,
	m0024,
	m0025,
	m0026,
	m0027,
	m0028,
	m0029,
	m0030,
	m0031,
	m0032,
	m0033,
	m0034,
	m0035,
	m0036,
	m0037,
	m0038,
	m0039,
	m0040,
	m0041,
	m0042,
	m0043,
	m0044,
	m0045,
	m0046,
	m0047,
	m0048,
	m0049,
	m0050,
	m0051,
	m0052,
	m0053,
	m0054,
];
