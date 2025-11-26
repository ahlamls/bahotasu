import { getDatabaseConnection } from "../db/index.js";

const db = () => getDatabaseConnection();

export const UserGroupModel = {
  assignUserToGroup({ userId, groupId }) {
    const now = new Date().toISOString();
    db()
      .prepare(
        `
        INSERT OR IGNORE INTO user_groups (user_id, group_id, created_at)
        VALUES (?, ?, ?)
      `,
      )
      .run(userId, groupId, now);
  },

  removeUserFromGroup({ userId, groupId }) {
    db()
      .prepare(`DELETE FROM user_groups WHERE user_id = ? AND group_id = ?`)
      .run(userId, groupId);
  },

  listGroupsForUser(userId) {
    return db()
      .prepare(
        `
        SELECT
          groups.id AS id,
          groups.slug AS slug,
          groups.name AS name,
          groups.description AS description,
          user_groups.created_at AS assignedAt
        FROM user_groups
        JOIN groups ON groups.id = user_groups.group_id
        WHERE user_groups.user_id = ?
        ORDER BY groups.name
        `,
      )
      .all(userId);
  },

  listUsersForGroup(groupId) {
    return db()
      .prepare(
        `
        SELECT
          users.id AS id,
          users.username AS username,
          users.name AS name,
          users.email AS email,
          user_groups.created_at AS assignedAt
        FROM user_groups
        JOIN users ON users.id = user_groups.user_id
        WHERE user_groups.group_id = ?
        ORDER BY users.username
        `,
      )
      .all(groupId);
  },

  isUserInGroup(userId, groupId) {
    if (!groupId) return false;
    const row = db()
      .prepare(
        `
        SELECT 1
        FROM user_groups
        WHERE user_id = ? AND group_id = ?
        LIMIT 1
        `,
      )
      .get(userId, groupId);
    return !!row;
  },
};
