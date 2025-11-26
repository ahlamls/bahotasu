import crypto from "node:crypto";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;

const encode = (salt, buffer) =>
  `scrypt:${salt.toString("hex")}:${buffer.toString("hex")}`;

export const hashPassword = (plain) => {
  if (!plain) throw new Error("Password is required");
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(plain, salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return encode(salt, derived);
};

export const verifyPassword = (plain, storedHash) => {
  if (!plain || !storedHash) return false;
  const parts = storedHash.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const hash = Buffer.from(parts[2], "hex");

  const derived = crypto.scryptSync(plain, salt, hash.length, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });

  return crypto.timingSafeEqual(hash, derived);
};

