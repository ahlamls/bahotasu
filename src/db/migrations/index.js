import { migration_001 } from "./001_init.js";
import { migration_002 } from "./002_sessions.js";
import { migration_003 } from "./003_logs_nullable_group.js";
import { migration_004 } from "./004_log_description.js";

const migrations = [migration_001, migration_002, migration_003, migration_004];

const ensureMigrationTable = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
};

const getAppliedVersions = (db) => {
  const rows = db.prepare("SELECT version FROM schema_migrations").all();
  return new Set(rows.map((row) => row.version));
};

export const applyMigrations = (db) => {
  ensureMigrationTable(db);
  const appliedVersions = getAppliedVersions(db);

  migrations.forEach((migration) => {
    if (appliedVersions.has(migration.version)) return;

    const run = db.transaction(() => {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
      ).run(migration.version, migration.name);
    });

    run();
    console.log(`[db] Applied migration v${migration.version} - ${migration.name}`);
  });
};
