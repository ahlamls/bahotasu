/**
 * Migration 007 — Add optional server target to logs.
 * Logs with server_id = NULL keep the existing local "This Server" behavior.
 * Remote logs store a servers.id reference so the log reader can fetch content over SSH.
 *
 * @module src/db/migrations/007_logs_server_target
 * @author OpenAI Codex GPT-5 / 2026-05-19
 */

export const migration_007 = {
  version: 7,
  name: "Add server target to logs",
  up(db) {
    db.exec(`
      ALTER TABLE logs ADD COLUMN server_id INTEGER REFERENCES servers(id) ON DELETE SET NULL;
      CREATE INDEX IF NOT EXISTS idx_logs_server_id ON logs(server_id);
    `);
    console.log("[db] Added optional server_id target to logs");
  },
};
