/**
 * EnvironmentFileModel - CRUD and access checks for admin-approved .env files.
 * The model stores only file metadata; actual .env content stays on the target server.
 *
 * @module src/models/environmentFiles
 * @author OpenAI Codex GPT-5 / 2026-05-20
 */

import { getDatabaseConnection } from "../db/index.js";
import { USER_ROLES } from "./constants.js";

const db = () => getDatabaseConnection();

const baseSelect = `
  environment_files.id,
  environment_files.server_id AS serverId,
  environment_files.group_id AS groupId,
  environment_files.title,
  environment_files.description,
  environment_files.file_path AS filePath,
  environment_files.is_active AS isActive,
  environment_files.created_by_user_id AS createdByUserId,
  environment_files.created_at AS createdAt,
  environment_files.updated_at AS updatedAt,
  groups.name AS groupName,
  groups.slug AS groupSlug,
  servers.name AS serverName,
  servers.auth_type AS serverAuthType
`;

const toBool = (value) => value === 1 || value === true;

const rowToEntity = (row) => {
  if (!row) return null;
  return {
    ...row,
    isActive: toBool(row.isActive),
  };
};

export const EnvironmentFileModel = {
  /**
   * Creates a new editable environment file registration.
   * The file path is not read during admin CRUD so missing-permission errors appear on edit.
   */
  create({ serverId, groupId, title, description = "", filePath, isActive = true, createdByUserId = null }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      INSERT INTO environment_files (server_id, group_id, title, description, file_path, is_active, created_by_user_id, created_at, updated_at)
      VALUES (@serverId, @groupId, @title, @description, @filePath, @isActive, @createdByUserId, @now, @now)
    `);
    const result = stmt.run({
      serverId: serverId || null,
      groupId: groupId || null,
      title,
      description,
      filePath,
      isActive: isActive ? 1 : 0,
      createdByUserId,
      now,
    });
    return this.findById(result.lastInsertRowid);
  },

  /** Returns all registrations for the superadmin management table. */
  listAll() {
    const rows = db()
      .prepare(`
        SELECT ${baseSelect}
        FROM environment_files
        LEFT JOIN groups ON groups.id = environment_files.group_id
        LEFT JOIN servers ON servers.id = environment_files.server_id
        ORDER BY environment_files.created_at DESC
      `)
      .all();
    return rows.map(rowToEntity);
  },

  /**
   * Returns active env files available to a user on the dashboard.
   * Superadmins see every active file; users see ungrouped files plus their groups.
   */
  listAvailableForUser(userId, userRole) {
    if (userRole === USER_ROLES.SUPERADMIN) {
      return this.listAll().filter((env) => env.isActive);
    }

    const rows = db()
      .prepare(`
        SELECT DISTINCT ${baseSelect}
        FROM environment_files
        LEFT JOIN groups ON groups.id = environment_files.group_id
        LEFT JOIN user_groups ON user_groups.group_id = groups.id
        LEFT JOIN servers ON servers.id = environment_files.server_id
        WHERE environment_files.is_active = 1
          AND (environment_files.group_id IS NULL OR user_groups.user_id = ?)
        ORDER BY COALESCE(groups.name, 'Ungrouped'), environment_files.title
      `)
      .all(userId);
    return rows.map(rowToEntity);
  },

  /** Finds one registration with display labels for routes and history. */
  findById(id) {
    const row = db()
      .prepare(`
        SELECT ${baseSelect}
        FROM environment_files
        LEFT JOIN groups ON groups.id = environment_files.group_id
        LEFT JOIN servers ON servers.id = environment_files.server_id
        WHERE environment_files.id = ?
      `)
      .get(id);
    return rowToEntity(row);
  },

  /** Updates only the admin-editable metadata fields. */
  update(id, fields) {
    const now = new Date().toISOString();
    const sets = ["updated_at = @now"];
    const params = { id, now };

    if (fields.serverId !== undefined) { sets.push("server_id = @serverId"); params.serverId = fields.serverId || null; }
    if (fields.groupId !== undefined) { sets.push("group_id = @groupId"); params.groupId = fields.groupId || null; }
    if (fields.title !== undefined) { sets.push("title = @title"); params.title = fields.title; }
    if (fields.description !== undefined) { sets.push("description = @description"); params.description = fields.description; }
    if (fields.filePath !== undefined) { sets.push("file_path = @filePath"); params.filePath = fields.filePath; }
    if (fields.isActive !== undefined) { sets.push("is_active = @isActive"); params.isActive = fields.isActive ? 1 : 0; }

    db()
      .prepare(`UPDATE environment_files SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);

    return this.findById(id);
  },

  /** Removes the Bahotasu registration only; it never deletes the target .env file. */
  remove(id) {
    db().prepare("DELETE FROM environment_files WHERE id = ?").run(id);
  },

  /**
   * Checks group access for env editing.
   * Inactive files are blocked for regular users but remain reachable to superadmins.
   */
  canAccess(user, envFile) {
    if (!user || !envFile) return false;
    if (user.role === USER_ROLES.SUPERADMIN) return true;
    if (!envFile.isActive) return false;
    if (!envFile.groupId) return true;
    const row = db()
      .prepare("SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?")
      .get(user.id, envFile.groupId);
    return !!row;
  },
};
