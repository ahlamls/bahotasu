/**
 * Migration 005 — Command Runner tables.
 * Creates servers, commands, and command_executions tables.
 * Seeds the local "This Server" record.
 *
 * @module src/db/migrations/005_command_runner
 * @author deepseek-v4-pro / 2026-05-04
 */

const timestampDefault = "STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')";

const schemaSql = `
CREATE TABLE IF NOT EXISTS servers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  host TEXT,
  port INTEGER NOT NULL DEFAULT 22,
  auth_type TEXT NOT NULL CHECK (auth_type IN ('local', 'key', 'password')),
  encrypted_private_key TEXT,
  encrypted_password TEXT,
  created_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  updated_at TEXT NOT NULL DEFAULT (${timestampDefault})
);

CREATE TABLE IF NOT EXISTS commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id INTEGER,
  group_id INTEGER,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  command TEXT NOT NULL,
  password_required INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  updated_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE SET NULL,
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS command_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id INTEGER,
  user_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  created_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  started_at TEXT,
  completed_at TEXT,
  exit_code INTEGER,
  output TEXT DEFAULT '',
  error_summary TEXT DEFAULT '',
  -- Denormalised fields for filtering and display after command deletion
  server_id INTEGER,
  command_name TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (command_id) REFERENCES commands(id) ON DELETE SET NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_commands_server_id ON commands(server_id);
CREATE INDEX IF NOT EXISTS idx_commands_group_id ON commands(group_id);
CREATE INDEX IF NOT EXISTS idx_command_executions_command_id ON command_executions(command_id);
CREATE INDEX IF NOT EXISTS idx_command_executions_user_id ON command_executions(user_id);
CREATE INDEX IF NOT EXISTS idx_command_executions_status ON command_executions(status);
CREATE INDEX IF NOT EXISTS idx_command_executions_created_at ON command_executions(created_at);
`;

export const migration_005 = {
  version: 5,
  name: "Command Runner tables",
  up(db) {
    db.exec(schemaSql);

    // Seed the local "This Server" record (undeletable, represents the Node.js host)
    // Use INSERT OR IGNORE to avoid duplicates on repeated migrations
    const existing = db
      .prepare("SELECT id FROM servers WHERE auth_type = 'local' AND host IS NULL")
      .get();
    if (!existing) {
      db.prepare(`
        INSERT INTO servers (name, host, port, auth_type)
        VALUES ('This Server', NULL, 0, 'local')
      `).run();
      console.log("[db] Seeded 'This Server' record");
    }
  },
};
