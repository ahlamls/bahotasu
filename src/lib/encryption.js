/**
 * Encryption module for Command Runner.
 * Provides AES-256-GCM encrypt/decrypt for SSH credentials.
 * Auto-generates BAHOTASU_ENC_KEY in .env if not present.
 *
 * @module src/lib/encryption
 * @author deepseek-v4-pro / 2026-05-04
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, "..", "..", ".env");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits for GCM
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

let encKey = null;

/**
 * Ensures BAHOTASU_ENC_KEY exists in environment.
 * If not set in process.env, generates a 32-byte hex key and appends to .env.
 * Exits the process if .env is not writable.
 *
 * @returns {Buffer} The encryption key as a Buffer
 */
const getEncryptionKey = () => {
  if (encKey) return encKey;

  let keyHex = process.env.BAHOTASU_ENC_KEY;

  if (!keyHex) {
    // Generate a new random 256-bit key as a hex string
    keyHex = crypto.randomBytes(KEY_LENGTH).toString("hex");

    try {
      // Append key to .env file so it persists across restarts
      const line = `\nBAHOTASU_ENC_KEY=${keyHex}\n`;
      fs.appendFileSync(ENV_PATH, line, "utf8");
      console.log("[encryption] Generated new BAHOTASU_ENC_KEY and saved to .env");
    } catch (err) {
      console.error(
        "[encryption] Failed to write BAHOTASU_ENC_KEY to .env file. " +
          "Ensure the .env file is writable by the Node.js process.",
        err,
      );
      process.exit(1);
    }

    // Set in current process environment so subsequent reads find it
    process.env.BAHOTASU_ENC_KEY = keyHex;
  }

  encKey = Buffer.from(keyHex, "hex");

  if (encKey.length !== KEY_LENGTH) {
    console.error(
      `[encryption] BAHOTASU_ENC_KEY must be ${KEY_LENGTH} bytes (${KEY_LENGTH * 2} hex chars). ` +
        `Got ${encKey.length} bytes.`,
    );
    process.exit(1);
  }

  return encKey;
};

/**
 * Encrypts a plaintext string using AES-256-GCM.
 * Returns a base64-encoded string containing IV + auth tag + ciphertext.
 * Format: base64( IV (12 bytes) + authTag (16 bytes) + ciphertext )
 *
 * @param {string} plain - The plaintext to encrypt
 * @returns {string} Base64-encoded encrypted data
 */
export const encrypt = (plain) => {
  if (!plain) return "";
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Prepend IV and authTag to ciphertext for single-value storage
  const combined = Buffer.concat([iv, authTag, encrypted]);
  return combined.toString("base64");
};

/**
 * Decrypts a base64-encoded ciphertext back to plaintext.
 * Expects the format produced by encrypt(): IV + authTag + ciphertext.
 *
 * @param {string} cipherBase64 - The base64-encoded encrypted data
 * @returns {string} The decrypted plaintext
 * @throws {Error} If decryption fails (wrong key, corrupted data, etc.)
 */
export const decrypt = (cipherBase64) => {
  if (!cipherBase64) return "";
  const key = getEncryptionKey();
  const combined = Buffer.from(cipherBase64, "base64");

  if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted data: too short");
  }

  const iv = combined.subarray(0, IV_LENGTH);
  const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (err) {
    throw new Error("Decryption failed: invalid key or corrupted data");
  }
};
