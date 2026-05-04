/**
 * Migration 006 — Add SSH username to servers table.
 * SSH connections require a remote username (e.g. root, ubuntu, deploy).
 * Existing rows default to 'root' for backward compatibility.
 *
 * @module src/db/migrations/006_server_username
 * @author deepseek-v4-flash / 2026-05-04
 */

export const migration_006 = {
  version: 6,
  name: "Add SSH username to servers",
  up(db) {
    db.exec(`
      ALTER TABLE servers ADD COLUMN username TEXT NOT NULL DEFAULT 'root';
    `);
    console.log("[db] Added username column to servers (default 'root')");
  },
};
