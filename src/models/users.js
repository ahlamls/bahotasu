import { getDatabaseConnection } from "../db/index.js";
import { USER_ROLES } from "./constants.js";

const db = () => getDatabaseConnection();

const baseSelect = `
  id,
  username,
  email,
  name,
  role,
  is_active AS isActive,
  last_login_at AS lastLoginAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export const UserModel = {
  create({ username, email, name, passwordHash, role = USER_ROLES.USER }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      INSERT INTO users (username, email, name, password_hash, role, created_at, updated_at)
      VALUES (@username, @email, @name, @passwordHash, @role, @now, @now)
    `);
    const result = stmt.run({ username, email, name, passwordHash, role, now });
    return this.findById(result.lastInsertRowid);
  },

  findById(id) {
    return db()
      .prepare(`SELECT ${baseSelect} FROM users WHERE id = ?`)
      .get(id);
  },

  findByUsernameOrEmail(identifier) {
    return db()
      .prepare(
        `SELECT ${baseSelect}, password_hash AS passwordHash FROM users WHERE username = ? OR email = ?`,
      )
      .get(identifier, identifier);
  },

  findByIdWithPassword(id) {
    return db()
      .prepare(
        `SELECT ${baseSelect}, password_hash AS passwordHash FROM users WHERE id = ?`,
      )
      .get(id);
  },

  listAll() {
    return db()
      .prepare(`SELECT ${baseSelect} FROM users ORDER BY created_at DESC`)
      .all();
  },

  updateProfile(id, { name }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      UPDATE users
      SET name = @name,
          updated_at = @now
      WHERE id = @id
    `);
    stmt.run({ id, name, now });
    return this.findById(id);
  },

  updatePassword(id, passwordHash) {
    const now = new Date().toISOString();
    db()
      .prepare(
        `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`,
      )
      .run(passwordHash, now, id);
    return this.findById(id);
  },

  setLastLogin(id) {
    const now = new Date().toISOString();
    db()
      .prepare(
        `UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?`,
      )
      .run(now, now, id);
  },

  deactivate(id) {
    const now = new Date().toISOString();
    db()
      .prepare(`UPDATE users SET is_active = 0, updated_at = ? WHERE id = ?`)
      .run(now, id);
  },

  remove(id) {
    db().prepare(`DELETE FROM users WHERE id = ?`).run(id);
  },
};
