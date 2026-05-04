/**
 * CommandModel — CRUD operations for the commands table.
 * Commands are pre-approved shell scripts defined by superadmins.
 * Access is gated by group membership (same pattern as logs).
 *
 * @module src/models/commands
 * @author deepseek-v4-pro / 2026-05-04
 */

import { getDatabaseConnection } from "../db/index.js";
import { USER_ROLES } from "./constants.js";

const db = () => getDatabaseConnection();

const baseSelect = `
  commands.id,
  commands.server_id AS serverId,
  commands.group_id AS groupId,
  commands.name,
  commands.description,
  commands.command,
  commands.password_required AS passwordRequired,
  commands.is_active AS isActive,
  commands.created_by_user_id AS createdByUserId,
  commands.created_at AS createdAt,
  commands.updated_at AS updatedAt
`;

const toBool = (value) => value === 1 || value === true;

const rowToEntity = (row) => {
  if (!row) return null;
  return {
    ...row,
    passwordRequired: toBool(row.passwordRequired),
    isActive: toBool(row.isActive),
  };
};

export const CommandModel = {
  /**
   * Creates a new command definition.
   * @param {Object} params
   * @param {number|null} params.serverId - References servers(id), null means local
   * @param {number|null} params.groupId - References groups(id), null = ungrouped
   * @param {string} params.name - Display name
   * @param {string} params.description - Optional description
   * @param {string} params.command - Shell command string (no user interpolation)
   * @param {boolean} params.passwordRequired - Whether re-auth is required
   * @param {boolean} params.isActive - Whether command can be executed
   * @param {number} params.createdByUserId - Superadmin who created it
   */
  create({ serverId, groupId, name, description = "", command, passwordRequired = false, isActive = true, createdByUserId }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      INSERT INTO commands (server_id, group_id, name, description, command, password_required, is_active, created_by_user_id, created_at, updated_at)
      VALUES (@serverId, @groupId, @name, @description, @command, @passwordRequired, @isActive, @createdByUserId, @now, @now)
    `);
    const result = stmt.run({
      serverId: serverId || null,
      groupId: groupId || null,
      name,
      description,
      command,
      passwordRequired: passwordRequired ? 1 : 0,
      isActive: isActive ? 1 : 0,
      createdByUserId: createdByUserId || null,
      now,
    });
    return this.findById(result.lastInsertRowid);
  },

  /** Returns all commands (for superadmin listing) */
  listAll() {
    const rows = db()
      .prepare(`
        SELECT ${baseSelect},
          servers.name AS serverName,
          groups.name AS groupName
        FROM commands
        LEFT JOIN servers ON servers.id = commands.server_id
        LEFT JOIN groups ON groups.id = commands.group_id
        ORDER BY commands.name
      `)
      .all();
    return rows.map(rowToEntity);
  },

  /**
   * Returns commands accessible to a given user.
   * Superadmins see all; regular users see commands in their assigned groups + ungrouped.
   */
  listForUser(userId, userRole) {
    if (userRole === USER_ROLES.SUPERADMIN) {
      return this.listAll();
    }

    const rows = db()
      .prepare(`
        SELECT ${baseSelect},
          servers.name AS serverName,
          groups.name AS groupName
        FROM commands
        LEFT JOIN servers ON servers.id = commands.server_id
        LEFT JOIN groups ON groups.id = commands.group_id
        WHERE commands.group_id IS NULL
           OR commands.group_id IN (
             SELECT group_id FROM user_groups WHERE user_id = ?
           )
        ORDER BY commands.name
      `)
      .all(userId);
    return rows.map(rowToEntity);
  },

  /** Finds a single command by ID, including related server and group names */
  findById(id) {
    const row = db()
      .prepare(`
        SELECT ${baseSelect},
          servers.name AS serverName,
          groups.name AS groupName,
          groups.slug AS groupSlug
        FROM commands
        LEFT JOIN servers ON servers.id = commands.server_id
        LEFT JOIN groups ON groups.id = commands.group_id
        WHERE commands.id = ?
      `)
      .get(id);
    return rowToEntity(row);
  },

  /**
   * Updates a command's fields. Returns the updated command.
   * Does not affect queued/running executions.
   */
  update(id, fields) {
    const now = new Date().toISOString();
    const sets = ["updated_at = @now"];
    const params = { id, now };

    if (fields.serverId !== undefined) { sets.push("server_id = @serverId"); params.serverId = fields.serverId || null; }
    if (fields.groupId !== undefined) { sets.push("group_id = @groupId"); params.groupId = fields.groupId || null; }
    if (fields.name !== undefined) { sets.push("name = @name"); params.name = fields.name; }
    if (fields.description !== undefined) { sets.push("description = @description"); params.description = fields.description; }
    if (fields.command !== undefined) { sets.push("command = @command"); params.command = fields.command; }
    if (fields.passwordRequired !== undefined) { sets.push("password_required = @passwordRequired"); params.passwordRequired = fields.passwordRequired ? 1 : 0; }
    if (fields.isActive !== undefined) { sets.push("is_active = @isActive"); params.isActive = fields.isActive ? 1 : 0; }

    db()
      .prepare(`UPDATE commands SET ${sets.join(", ")} WHERE id = @id`)
      .run(params);

    return this.findById(id);
  },

  /** Deletes a command. Execution history keeps command_id as NULL (ON DELETE SET NULL). */
  remove(id) {
    db().prepare(`DELETE FROM commands WHERE id = ?`).run(id);
  },

  /**
   * Checks whether a user can access a command based on group membership.
   * Superadmins always have access. Users need group match or ungrouped command.
   */
  canAccess(user, command) {
    if (!user || !command) return false;
    if (user.role === USER_ROLES.SUPERADMIN) return true;
    if (!command.groupId) return true;
    // If command has a group, user must be a member
    const row = db()
      .prepare("SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?")
      .get(user.id, command.groupId);
    return !!row;
  },
};
