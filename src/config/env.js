import dotenv from "dotenv";

dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const appConfig = Object.freeze({
  port: parseNumber(process.env.PORT, 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  sqliteFile: process.env.SQLITE_FILE || "./data/bahotasu.sqlite",
});

