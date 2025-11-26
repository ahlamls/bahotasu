const timestampDefault = "STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now')";

const schemaSql = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  remember INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  created_at TEXT NOT NULL DEFAULT (${timestampDefault}),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`;

export const migration_002 = {
  version: 2,
  name: "Sessions table",
  up(db) {
    db.exec(schemaSql);
  },
};

