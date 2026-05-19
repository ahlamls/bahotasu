/**
 * LogModel — CRUD operations for registered log files.
 * Logs may point at the local Bahotasu host (server_id NULL) or a remote server.
 *
 * Remote log support added by OpenAI Codex GPT-5 / 2026-05-19:
 * server_id is stored on the log record so read/search/clear can route through SSH.
 */

import { getDatabaseConnection } from "../db/index.js";

const db = () => getDatabaseConnection();

const baseSelect = `
  logs.id AS id,
  logs.group_id AS groupId,
  logs.name AS name,
  logs.description AS description,
  logs.file_path AS filePath,
  logs.tail_lines AS tailLines,
  logs.allow_clear AS allowClear,
  logs.server_id AS serverId,
  logs.created_by_user_id AS createdByUserId,
  logs.created_at AS createdAt,
  logs.updated_at AS updatedAt,
  groups.slug AS groupSlug,
  groups.name AS groupName,
  groups.description AS groupDescription,
  servers.name AS serverName,
  servers.auth_type AS serverAuthType
`;

export const LogModel = {
  create({
    groupId,
    name,
    description = "",
    filePath,
    tailLines = 500,
    allowClear = false,
    serverId = null,
    createdByUserId = null,
  }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      INSERT INTO logs (group_id, name, description, file_path, tail_lines, allow_clear, server_id, created_by_user_id, created_at, updated_at)
      VALUES (@groupId, @name, @description, @filePath, @tailLines, @allowClear, @serverId, @createdByUserId, @now, @now)
    `);

    const result = stmt.run({
      groupId,
      name,
      description,
      filePath,
      tailLines,
      allowClear: allowClear ? 1 : 0,
      serverId: serverId || null,
      createdByUserId,
      now,
    });
    return this.findById(result.lastInsertRowid);
  },

  findById(id) {
    return db()
      .prepare(
        `
        SELECT ${baseSelect}
        FROM logs
        LEFT JOIN groups ON groups.id = logs.group_id
        LEFT JOIN servers ON servers.id = logs.server_id
        WHERE logs.id = ?
        `,
      )
      .get(id);
  },

  listByGroup(groupId) {
    return db()
      .prepare(
        `
        SELECT ${baseSelect}
        FROM logs
        LEFT JOIN groups ON groups.id = logs.group_id
        LEFT JOIN servers ON servers.id = logs.server_id
        WHERE logs.group_id = ?
        ORDER BY logs.name
        `,
      )
      .all(groupId);
  },

  listAll() {
    return db()
      .prepare(
        `
        SELECT ${baseSelect}
        FROM logs
        LEFT JOIN groups ON groups.id = logs.group_id
        LEFT JOIN servers ON servers.id = logs.server_id
        ORDER BY logs.created_at DESC
        `,
      )
      .all();
  },

  listForUser(userId) {
    return db()
      .prepare(
        `
        SELECT DISTINCT ${baseSelect}
        FROM logs
        LEFT JOIN groups ON groups.id = logs.group_id
        LEFT JOIN user_groups ON user_groups.group_id = groups.id
        LEFT JOIN servers ON servers.id = logs.server_id
        WHERE logs.group_id IS NULL OR user_groups.user_id = ?
        ORDER BY COALESCE(groups.name, 'Ungrouped'), logs.name
        `,
      )
      .all(userId);
  },

  update(id, { name, description, filePath, tailLines, allowClear, groupId, serverId }) {
    const now = new Date().toISOString();
    const groupProvided = groupId !== undefined;
    const serverProvided = serverId !== undefined;
    const stmt = db().prepare(`
      UPDATE logs
      SET
        name = COALESCE(@name, name),
        description = COALESCE(@description, description),
        file_path = COALESCE(@filePath, file_path),
        tail_lines = COALESCE(@tailLines, tail_lines),
        allow_clear = COALESCE(@allowClear, allow_clear),
        group_id = CASE WHEN @groupProvided THEN @groupId ELSE group_id END,
        server_id = CASE WHEN @serverProvided THEN @serverId ELSE server_id END,
        updated_at = @now
      WHERE id = @id
    `);

    stmt.run({
      id,
      name,
      description,
      filePath,
      tailLines,
      allowClear: typeof allowClear === "boolean" ? (allowClear ? 1 : 0) : undefined,
      groupId,
      groupProvided: groupProvided ? 1 : 0,
      serverId: serverId || null,
      serverProvided: serverProvided ? 1 : 0,
      now,
    });

    return this.findById(id);
  },

  remove(id) {
    db().prepare(`DELETE FROM logs WHERE id = ?`).run(id);
  },
};
