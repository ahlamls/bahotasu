/**
 * ServerModel — CRUD operations for the servers table.
 * Manages execution targets: local ("This Server") or remote SSH hosts.
 * SSH credentials are stored encrypted; decryption happens at execution time.
 *
 * @module src/models/servers
 * @author deepseek-v4-pro / 2026-05-04
 */

import { getDatabaseConnection } from "../db/index.js";

const db = () => getDatabaseConnection();

const baseSelect = `
  id,
  name,
  host,
  port,
  username,
  auth_type AS authType,
  encrypted_private_key AS encryptedPrivateKey,
  encrypted_password AS encryptedPassword,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const toBool = (value) => value === 1 || value === true;

export const ServerModel = {
  /**
   * Creates a new server record. Encrypted credentials should be pre-encrypted
   * by the caller using the encryption module before passing in.
   */
  create({ name, host = null, port = 22, username = "root", authType, encryptedPrivateKey = null, encryptedPassword = null }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      INSERT INTO servers (name, host, port, username, auth_type, encrypted_private_key, encrypted_password, created_at, updated_at)
      VALUES (@name, @host, @port, @username, @authType, @encryptedPrivateKey, @encryptedPassword, @now, @now)
    `);
    const result = stmt.run({
      name,
      host: host || null,
      port,
      username,
      authType,
      encryptedPrivateKey: encryptedPrivateKey || null,
      encryptedPassword: encryptedPassword || null,
      now,
    });
    return this.findById(result.lastInsertRowid);
  },

  /** Returns all servers ordered by name */
  listAll() {
    return db()
      .prepare(`SELECT ${baseSelect} FROM servers ORDER BY name`)
      .all();
  },

  /** Finds a single server by ID */
  findById(id) {
    return db()
      .prepare(`SELECT ${baseSelect} FROM servers WHERE id = ?`)
      .get(id);
  },

  /** Returns the local "This Server" record (host IS NULL, auth_type = 'local') */
  findLocalServer() {
    return db()
      .prepare(`SELECT ${baseSelect} FROM servers WHERE auth_type = 'local' AND host IS NULL LIMIT 1`)
      .get();
  },

  /**
   * Updates a server record. Pass new encrypted credentials only if changed.
   * Returns the updated server.
   */
  update(id, { name, host, port, username, authType, encryptedPrivateKey, encryptedPassword }) {
    const now = new Date().toISOString();

    // Build dynamic UPDATE to only overwrite credential columns when new values are provided
    const fields = [];
    const params = { id, now };

    if (name !== undefined) { fields.push("name = @name"); params.name = name; }
    if (host !== undefined) { fields.push("host = @host"); params.host = host || null; }
    if (port !== undefined) { fields.push("port = @port"); params.port = port; }
    if (username !== undefined) { fields.push("username = @username"); params.username = username; }
    if (authType !== undefined) { fields.push("auth_type = @authType"); params.authType = authType; }

    // Only update credential fields if new values are explicitly provided (non-nullish)
    // This allows keeping existing credentials by omitting the field
    if (encryptedPrivateKey !== undefined) {
      fields.push("encrypted_private_key = @encryptedPrivateKey");
      params.encryptedPrivateKey = encryptedPrivateKey || null;
    }
    if (encryptedPassword !== undefined) {
      fields.push("encrypted_password = @encryptedPassword");
      params.encryptedPassword = encryptedPassword || null;
    }

    if (fields.length === 0) return this.findById(id);

    fields.push("updated_at = @now");

    db()
      .prepare(`UPDATE servers SET ${fields.join(", ")} WHERE id = @id`)
      .run(params);

    return this.findById(id);
  },

  /** Deletes a server by ID. Does not allow deletion of the local server. */
  remove(id) {
    db().prepare(`DELETE FROM servers WHERE id = ?`).run(id);
  },

  /** Returns true if the server is the local machine (undeletable). */
  isLocalServer(server) {
    return server && server.authType === "local" && server.host === null;
  },
};
