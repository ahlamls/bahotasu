export const migration_004 = {
  version: 4,
  name: "Add description to logs",
  up(db) {
    db.exec(`ALTER TABLE logs ADD COLUMN description TEXT DEFAULT '';`);
  },
};

