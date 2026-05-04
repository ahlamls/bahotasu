import dotenv from "dotenv";

dotenv.config();

const parseNumber = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  const lower = String(value).toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
};

export const appConfig = Object.freeze({
  port: parseNumber(process.env.PORT, 4000),
  nodeEnv: process.env.NODE_ENV || "development",
  sqliteFile: process.env.SQLITE_FILE || "./data/bahotasu.sqlite",
  // Command Runner — 256-bit AES-GCM encryption key, auto-generated if not set
  encKey: process.env.BAHOTASU_ENC_KEY || null,
  // Maximum seconds a command may run before being killed (default 30)
  commandTimeoutSec: parseNumber(process.env.COMMAND_TIMEOUT_SEC, 30),
});

