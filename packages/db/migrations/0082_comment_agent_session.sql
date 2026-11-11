-- Record which agent session wrote a comment, so a completion report can be traced to a
-- specific worker. author_kind only says "agent"; several workers usually share one
-- credential and one user. Plain TEXT with no FK, like agent_sessions.credential_id:
-- D1 does not reliably run ON DELETE actions, and a comment should keep the id of a
-- session that has since ended. NULL for comments written by a human, written without a
-- session, or written before this column existed.
ALTER TABLE issue_comments ADD COLUMN agent_session_id TEXT;
