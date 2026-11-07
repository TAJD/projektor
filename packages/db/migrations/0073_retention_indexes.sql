CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity(created_at);
CREATE INDEX IF NOT EXISTS idx_wiki_notifications_created_at ON wiki_notifications(created_at);
PRAGMA optimize;
