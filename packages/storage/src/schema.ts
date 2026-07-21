export const schemaSql = `PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  root_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  owner TEXT NOT NULL,
  scope TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  summary TEXT,
  summary_source TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  modified_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL,
  UNIQUE(workspace_id, path),
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_notes_workspace_path ON notes(workspace_id, path);
CREATE INDEX IF NOT EXISTS idx_notes_workspace_type ON notes(workspace_id, type);

CREATE VIRTUAL TABLE IF NOT EXISTS note_fts USING fts5(
  note_id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  summary,
  headings,
  body,
  path UNINDEXED
);

CREATE VIRTUAL TABLE IF NOT EXISTS note_fts_trigram USING fts5(
  note_id UNINDEXED,
  workspace_id UNINDEXED,
  title,
  summary,
  headings,
  body,
  path UNINDEXED,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  path TEXT NOT NULL,
  heading_path TEXT NOT NULL,
  text TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  token_count INTEGER NOT NULL,
  FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chunks_note_id ON chunks(note_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_workspace_updated ON sessions(workspace_id, updated_at);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  tool_calls_json TEXT,
  tool_result_json TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  compacted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  message_id UNINDEXED,
  session_id UNINDEXED,
  content,
  role
);

CREATE VIRTUAL TABLE IF NOT EXISTS message_fts_trigram USING fts5(
  message_id UNINDEXED,
  session_id UNINDEXED,
  content,
  role,
  tokenize='trigram'
);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL,
  risk TEXT NOT NULL,
  proposal_type TEXT NOT NULL,
  target_path TEXT,
  payload_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  source_turn_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  applied_at TEXT,
  superseded_by TEXT,
  failure_reason TEXT,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_review_items_workspace_state ON review_items(workspace_id, state);

CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_path TEXT,
  review_item_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY(review_item_id) REFERENCES review_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_events_workspace_created ON activity_events(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS import_jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  batch_name TEXT NOT NULL,
  state TEXT NOT NULL,
  attachment_dir TEXT NOT NULL,
  summary_note_path TEXT NOT NULL,
  source_files_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failure_reason TEXT,
  FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_workspace_state ON import_jobs(workspace_id, state);
`;
