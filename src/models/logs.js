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
  logs.created_by_user_id AS createdByUserId,
  logs.created_at AS createdAt,
  logs.updated_at AS updatedAt,
  groups.slug AS groupSlug,
  groups.name AS groupName,
  groups.description AS groupDescription
`;

export const LogModel = {
  create({
    groupId,
    name,
    description = "",
    filePath,
    tailLines = 500,
    allowClear = false,
    createdByUserId = null,
  }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      INSERT INTO logs (group_id, name, description, file_path, tail_lines, allow_clear, created_by_user_id, created_at, updated_at)
      VALUES (@groupId, @name, @description, @filePath, @tailLines, @allowClear, @createdByUserId, @now, @now)
    `);

    const result = stmt.run({
      groupId,
      name,
      description,
      filePath,
      tailLines,
      allowClear: allowClear ? 1 : 0,
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
        WHERE logs.group_id IS NULL OR user_groups.user_id = ?
        ORDER BY COALESCE(groups.name, 'Ungrouped'), logs.name
        `,
      )
      .all(userId);
  },

  update(id, { name, description, filePath, tailLines, allowClear, groupId }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      UPDATE logs
      SET
        name = COALESCE(@name, name),
        description = COALESCE(@description, description),
        file_path = COALESCE(@filePath, file_path),
        tail_lines = COALESCE(@tailLines, tail_lines),
        allow_clear = COALESCE(@allowClear, allow_clear),
        group_id = COALESCE(@groupId, group_id),
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
      now,
    });

    return this.findById(id);
  },

  remove(id) {
    db().prepare(`DELETE FROM logs WHERE id = ?`).run(id);
  },
};
