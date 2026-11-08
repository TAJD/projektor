CREATE TABLE IF NOT EXISTS issue_labels (
  issue_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (issue_id, label)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_issue_labels_ws_label_lower ON issue_labels(workspace_id, lower(label));
CREATE INDEX IF NOT EXISTS idx_issue_labels_ws_label ON issue_labels(workspace_id, label);
INSERT OR IGNORE INTO issue_labels (issue_id, workspace_id, label)
SELECT i.id, i.workspace_id, j.value
FROM issues i, json_each(CASE WHEN json_valid(i.labels) THEN CASE WHEN json_type(i.labels) = 'array' THEN i.labels ELSE '[]' END ELSE '[]' END) j
WHERE j.type = 'text';
PRAGMA optimize;
