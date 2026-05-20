/**
 * Migration 008 - Environment Variables manager tables.
 * Stores admin-approved env file registrations and redacted update history.
 *
 * @module src/db/migrations/008_environment_variables
 * @author OpenAI Codex GPT-5 / 2026-05-20
 */

const timestampDefault = "STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')";

const schemaSql = `
CREATE TABLE IF NOT EXISTS environment_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER,
  group_id INTEGER,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  file_path TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  updated_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS environment_file_updates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  environment_file_id INTEGER,
  user_id INTEGER NOT NULL,
  environment_title TEXT NOT NULL DEFAULT '',
  environment_file_path TEXT NOT NULL DEFAULT '',
  server_name TEXT NOT NULL DEFAULT '',
  previous_hash TEXT NOT NULL DEFAULT '',
  current_hash TEXT NOT NULL DEFAULT '',
  changes_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  FOREIGN KEY (environment_file_id) REFERENCES environment_files(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_environment_files_server_id ON environment_files(server_id);
CREATE INDEX IF NOT EXISTS idx_environment_files_group_id ON environment_files(group_id);
CREATE INDEX IF NOT EXISTS idx_environment_files_active ON environment_files(is_active);
CREATE INDEX IF NOT EXISTS idx_environment_file_updates_file_id ON environment_file_updates(environment_file_id);
CREATE INDEX IF NOT EXISTS idx_environment_file_updates_user_id ON environment_file_updates(user_id);
CREATE INDEX IF NOT EXISTS idx_environment_file_updates_created_at ON environment_file_updates(created_at);
`;

export const migration_008 = {
  version: 8,
  name: "Environment Variables manager tables",
  up(db) {
    // These tables keep env-file metadata separate from the actual env content,
    // while update history stores only redacted changes to avoid duplicating secrets.
    db.exec(schemaSql);
  },
};
