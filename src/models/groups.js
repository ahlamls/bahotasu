import { getDatabaseConnection } from "../db/index.js";

const db = () => getDatabaseConnection();

const baseSelect = `
  id,
  slug,
  name,
  description,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export const GroupModel = {
  create({ slug, name, description = "" }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      INSERT INTO groups (slug, name, description, created_at, updated_at)
      VALUES (@slug, @name, @description, @now, @now)
    `);
    const result = stmt.run({ slug, name, description, now });
    return this.findById(result.lastInsertRowid);
  },

  listAll() {
    return db().prepare(`SELECT ${baseSelect} FROM groups ORDER BY name`).all();
  },

  findById(id) {
    return db()
      .prepare(`SELECT ${baseSelect} FROM groups WHERE id = ?`)
      .get(id);
  },

  findBySlug(slug) {
    return db()
      .prepare(`SELECT ${baseSelect} FROM groups WHERE slug = ?`)
      .get(slug);
  },

  update(id, { name, description }) {
    const now = new Date().toISOString();
    db()
      .prepare(
        `
        UPDATE groups
        SET name = @name,
            description = @description,
            updated_at = @now
        WHERE id = @id
        `,
      )
      .run({ id, name, description, now });
    return this.findById(id);
  },

  remove(id) {
    db().prepare(`DELETE FROM groups WHERE id = ?`).run(id);
  },
};
