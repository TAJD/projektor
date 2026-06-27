-- PROJ-102: scope wiki pages per project
ALTER TABLE wiki_pages ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS wiki_pages_project_id_idx ON wiki_pages(project_id);
