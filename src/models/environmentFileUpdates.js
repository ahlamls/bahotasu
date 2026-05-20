/**
 * EnvironmentFileUpdateModel - redacted audit history for env saves.
 * The change list intentionally avoids storing plaintext secret values.
 *
 * @module src/models/environmentFileUpdates
 * @author OpenAI Codex GPT-5 / 2026-05-20
 */

import { getDatabaseConnection } from "../db/index.js";

const db = () => getDatabaseConnection();

const baseSelect = `
  efu.id,
  efu.environment_file_id AS environmentFileId,
  efu.user_id AS userId,
  efu.environment_title AS environmentTitle,
  efu.environment_file_path AS environmentFilePath,
  efu.server_name AS serverName,
  efu.previous_hash AS previousHash,
  efu.current_hash AS currentHash,
  efu.changes_json AS changesJson,
  efu.created_at AS createdAt,
  users.name AS userName,
  users.username AS username
`;

const rowToEntity = (row) => {
  if (!row) return null;
  let changes = [];
  try {
    changes = JSON.parse(row.changesJson || "[]");
  } catch (_) {
    changes = [];
  }
  return {
    ...row,
    changes,
  };
};

export const EnvironmentFileUpdateModel = {
  /** Inserts one redacted save-history row after a successful file write. */
  create({
    environmentFileId,
    userId,
    environmentTitle,
    environmentFilePath,
    serverName,
    previousHash,
    currentHash,
    changes,
  }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      INSERT INTO environment_file_updates (
        environment_file_id,
        user_id,
        environment_title,
        environment_file_path,
        server_name,
        previous_hash,
        current_hash,
        changes_json,
        created_at
      )
      VALUES (
        @environmentFileId,
        @userId,
        @environmentTitle,
        @environmentFilePath,
        @serverName,
        @previousHash,
        @currentHash,
        @changesJson,
        @now
      )
    `);
    const result = stmt.run({
      environmentFileId: environmentFileId || null,
      userId,
      environmentTitle: environmentTitle || "",
      environmentFilePath: environmentFilePath || "",
      serverName: serverName || "",
      previousHash,
      currentHash,
      changesJson: JSON.stringify(changes || []),
      now,
    });
    return this.findById(result.lastInsertRowid);
  },

  /** Finds a single update row with parsed changes. */
  findById(id) {
    const row = db()
      .prepare(`
        SELECT ${baseSelect}
        FROM environment_file_updates efu
        LEFT JOIN users ON users.id = efu.user_id
        WHERE efu.id = ?
      `)
      .get(id);
    return rowToEntity(row);
  },

  /** Lists recent updates for one environment file. */
  listByEnvironment(environmentFileId, { limit = 100 } = {}) {
    const rows = db()
      .prepare(`
        SELECT ${baseSelect}
        FROM environment_file_updates efu
        LEFT JOIN users ON users.id = efu.user_id
        WHERE efu.environment_file_id = ?
        ORDER BY efu.created_at DESC
        LIMIT ?
      `)
      .all(environmentFileId, limit);
    return rows.map(rowToEntity);
  },
};
