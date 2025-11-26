const timestampDefault = "STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')";

const createNewTable = `
CREATE TABLE logs_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER,
  name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  tail_lines INTEGER NOT NULL DEFAULT 500,
  allow_clear INTEGER NOT NULL DEFAULT 0,
  created_by_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  updated_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
`;

const indexesSql = `
CREATE INDEX IF NOT EXISTS idx_logs_group_id ON logs(group_id);
`;

export const migration_003 = {
  version: 3,
  name: "Allow logs without group",
  up(db) {
    const run = db.transaction(() => {
      db.exec(createNewTable);
      db.exec(`
        INSERT INTO logs_new (id, group_id, name, file_path, tail_lines, allow_clear, created_by_user_id, created_at, updated_at)
        SELECT id, group_id, name, file_path, tail_lines, allow_clear, created_by_user_id, created_at, updated_at
        FROM logs;
      `);
      db.exec("DROP TABLE logs;");
      db.exec("ALTER TABLE logs_new RENAME TO logs;");
      db.exec(indexesSql);
    });
    run();
  },
};

