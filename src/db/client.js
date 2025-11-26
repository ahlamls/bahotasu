import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { appConfig } from "../config/env.js";
import { applyMigrations } from "./migrations/index.js";

let dbInstance = null;

const resolvePath = (target) => {
  if (path.isAbsolute(target)) return target;
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, "..", "..", target);
};

const ensureDirectory = (filePath) => {
  const directory = path.dirname(filePath);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }
};

export const initDatabase = () => {
  if (dbInstance) return dbInstance;

  const filePath = resolvePath(appConfig.sqliteFile);
  ensureDirectory(filePath);

  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  applyMigrations(db);

  dbInstance = db;
  return dbInstance;
};

export const getDatabaseConnection = () => {
  if (!dbInstance) {
    throw new Error("Database has not been initialized. Call initDatabase() first.");
  }
  return dbInstance;
};

export const getDatabasePath = () => resolvePath(appConfig.sqliteFile);

