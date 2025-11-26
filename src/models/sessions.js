import crypto from "node:crypto";
import { getDatabaseConnection } from "../db/index.js";

const db = () => getDatabaseConnection();

const nowIso = () => new Date().toISOString();

const hashToken = (token) =>
  crypto.createHash("sha256").update(token).digest("hex");

const toBool = (value) => value === 1 || value === true;

const sessionRowToEntity = (row) => {
  if (!row) return null;
  return {
    id: row.sessionId,
    userId: row.sessionUserId,
    remember: toBool(row.sessionRemember),
    expiresAt: row.sessionExpiresAt,
    lastUsedAt: row.sessionLastUsedAt,
    user: {
      id: row.userId,
      username: row.username,
      email: row.email,
      name: row.name,
      role: row.role,
      isActive: toBool(row.isActive),
    },
  };
};

const ttlMs = (remember) =>
  (remember ? 30 : 1) * 24 * 60 * 60 * 1000; // 30 days vs 1 day

export const SessionModel = {
  create({ userId, remember = false }) {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const now = nowIso();
    const expiresAt = new Date(Date.now() + ttlMs(remember)).toISOString();

    const stmt = db().prepare(`
      INSERT INTO sessions (user_id, token_hash, remember, expires_at, created_at, last_used_at)
      VALUES (@userId, @tokenHash, @remember, @expiresAt, @now, @now)
    `);
    const result = stmt.run({
      userId,
      tokenHash,
      remember: remember ? 1 : 0,
      expiresAt,
      now,
    });

    return { id: result.lastInsertRowid, token, expiresAt };
  },

  findActiveByToken(token) {
    if (!token) return null;
    const tokenHash = hashToken(token);
    const now = nowIso();

    const row = db()
      .prepare(
        `
        SELECT
          sessions.id AS sessionId,
          sessions.user_id AS sessionUserId,
          sessions.remember AS sessionRemember,
          sessions.expires_at AS sessionExpiresAt,
          sessions.last_used_at AS sessionLastUsedAt,
          users.id AS userId,
          users.username AS username,
          users.email AS email,
          users.name AS name,
          users.role AS role,
          users.is_active AS isActive
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
          AND sessions.expires_at > ?
          AND users.is_active = 1
      `,
      )
      .get(tokenHash, now);

    return sessionRowToEntity(row);
  },

  touch(id) {
    const now = nowIso();
    db()
      .prepare(`UPDATE sessions SET last_used_at = ? WHERE id = ?`)
      .run(now, id);
  },

  deleteById(id) {
    db().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
  },

  deleteByToken(token) {
    if (!token) return;
    const tokenHash = hashToken(token);
    db().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
  },

  deleteExpired() {
    const now = nowIso();
    db().prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(now);
  },
};

