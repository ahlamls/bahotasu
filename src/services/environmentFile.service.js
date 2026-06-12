/**
 * EnvironmentFileService - validates, serializes, reads, and writes editable .env files.
 * Browser requests submit structured JSON only; this service builds the final env text.
 *
 * @module src/services/environmentFile.service
 * @author OpenAI Codex GPT-5 / 2026-05-20
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import posixPath from "node:path/posix";
import { Client } from "ssh2";
import { ServerModel } from "../models/index.js";
import { decrypt } from "../lib/encryption.js";

export const ENV_VARIABLE_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

const NUMBER_LITERAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Removes inline comments from unquoted parts of an existing env value.
 * Example: ENVIRONMENT="staging" #staging or live -> "staging".
 */
const stripInlineComment = (value) => {
  let quote = "";
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }

  return value;
};

/**
 * Splits a raw value portion (everything after the first =) into the value part
 * and the inline comment part. Quote-aware: # inside double/single quotes is
 * not treated as a comment marker. This prevents bahotasu flags inside quoted
 * values from being detected.
 * Added by Claude Sonnet 4 / 2026-06-12.
 */
const splitInlineComment = (rawValue) => {
  let inDoubleQuote = false;
  let inSingleQuote = false;
  let escaped = false;

  for (let i = 0; i < rawValue.length; i++) {
    const ch = rawValue[i];

    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (inDoubleQuote) {
      if (ch === '"') inDoubleQuote = false;
      continue;
    }
    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(rawValue[i - 1]))) {
      return {
        valuePart: rawValue.slice(0, i),
        commentPart: rawValue.slice(i + 1).trimStart(),
      };
    }
  }

  return { valuePart: rawValue, commentPart: "" };
};

/**
 * Detects bahotasu flags (secret, block, hide) in an inline comment string.
 * Uses word-boundary regex to prevent partial matches (e.g. "my-bahotasu-secret").
 * Returns the isSecret/isBlocked/isHidden booleans and the cleaned display comment.
 * Added by Claude Sonnet 4 / 2026-06-12.
 */
const BAHOTASU_FLAG_PATTERNS = [
  { key: "isSecret", pattern: /\bbahotasu-secret\b/ },
  { key: "isBlocked", pattern: /\bbahotasu-block\b/ },
  { key: "isHidden", pattern: /\bbahotasu-hide\b/ },
];

const extractFlags = (commentPart) => {
  const result = { isSecret: false, isBlocked: false, isHidden: false };
  if (!commentPart) return { ...result, inlineComment: "" };

  const trimmed = String(commentPart).trim();
  for (const { key, pattern } of BAHOTASU_FLAG_PATTERNS) {
    if (pattern.test(trimmed)) {
      result[key] = true;
    }
  }

  let displayComment = trimmed;
  for (const { pattern } of BAHOTASU_FLAG_PATTERNS) {
    displayComment = displayComment.replace(pattern, "").trim();
  }

  return { ...result, inlineComment: displayComment };
};

/**
 * Hashes raw file content so saves can reject stale browser edits.
 */
export const hashEnvText = (text) =>
  crypto.createHash("sha256").update(String(text), "utf8").digest("hex");

const normalizeLineEndings = (text) => String(text || "").replace(/\r\n?/g, "\n");

const splitEnvLines = (text) => {
  const normalized = normalizeLineEndings(text);
  if (normalized === "") return [];
  const lines = normalized.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
};

/**
 * Splits env text into logical lines, treating newlines inside double-quoted
 * values as part of the same logical line (multiline value support).
 * Uses a simple state machine tracking double-quote open/close.
 * Added by Claude Sonnet 4 / 2026-06-12.
 */
const splitIntoLogicalLines = (text) => {
  const normalized = normalizeLineEndings(text || "");
  if (normalized === "") return [];
  const lines = [];
  let current = "";
  let inDoubleQuote = false;
  for (const ch of normalized) {
    if (ch === '"') inDoubleQuote = !inDoubleQuote;
    if (ch === "\n" && !inDoubleQuote) {
      lines.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current !== "") lines.push(current);
  return lines;
};

const countUnquotedEquals = (value) => {
  let count = 0;
  let inDoubleQuote = false;
  for (const ch of String(value)) {
    if (ch === '"') inDoubleQuote = !inDoubleQuote;
    if (ch === "=" && !inDoubleQuote) count += 1;
  }
  return count;
};

/**
 * Parses a supported variable value from an existing env line.
 * Fully quoted strings are unescaped for editing; unquoted values are kept as typed.
 */
const parseValue = (rawValue, lineNumber) => {
  const value = stripInlineComment(rawValue).trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0];
    if (!value.endsWith(quote) || value.length === 1) {
      throw new Error(`Line ${lineNumber}: quoted value must end with the same quote character.`);
    }
    const inner = value.slice(1, -1);
    return quote === '"'
      ? inner.replace(/\\(["\\])/g, "$1")
      : inner.replace(/\\(['\\])/g, "$1");
  }
  return value;
};

/**
 * Parses a single env line into the strict editable subset used by the UI.
 * Supports bahotasu flags in inline comments: bahotasu-secret, bahotasu-block, bahotasu-hide.
 * Added by Claude Sonnet 4 / 2026-06-12.
 */
let lineIdCounter = 0;

const generateLineId = () => `_l${(lineIdCounter += 1)}`;

const parseEnvLine = (line, index) => {
  const lineNumber = index + 1;
  const trimmedLine = line.trim();
  if (trimmedLine === "") {
    return { type: "blank" };
  }

  if (trimmedLine.startsWith("#")) {
    const body = trimmedLine.slice(1);
    if (body.includes("=")) {
      // Use the value-only portion for equals count check
      const { valuePart: bodyValuePart } = splitInlineComment(body);
      if (countUnquotedEquals(bodyValuePart) > 1) {
        return { type: "readonly_comment", text: body };
      }
      const separatorIndex = body.indexOf("=");
      const name = body.slice(0, separatorIndex).trim();
      const rawValue = body.slice(separatorIndex + 1);
      if (!ENV_VARIABLE_NAME_PATTERN.test(name)) {
        throw new Error(`Line ${lineNumber}: disabled variable name is invalid.`);
      }
      const { valuePart, commentPart } = splitInlineComment(rawValue);
      const flags = extractFlags(commentPart);
      return {
        type: "variable",
        name,
        value: parseValue(valuePart.trim(), lineNumber),
        enabled: false,
        ...flags,
        _id: generateLineId(),
      };
    }
    return { type: "comment", text: body };
  }

  if (!trimmedLine.includes("=")) {
    throw new Error(`Line ${lineNumber}: non-comment lines must use KEY=value.`);
  }

  const separatorIndex = trimmedLine.indexOf("=");
  const name = trimmedLine.slice(0, separatorIndex).trim();
  const rawValue = trimmedLine.slice(separatorIndex + 1);
  if (!ENV_VARIABLE_NAME_PATTERN.test(name)) {
    throw new Error(`Line ${lineNumber}: variable name is invalid.`);
  }

  const { valuePart, commentPart } = splitInlineComment(rawValue);
  // Check for extra = in the value portion only
  if (countUnquotedEquals(valuePart) > 0) {
    throw new Error(`Line ${lineNumber}: variable lines cannot contain more than one "=".`);
  }
  const flags = extractFlags(commentPart);

  return {
    type: "variable",
    name,
    value: parseValue(valuePart.trim(), lineNumber),
    enabled: true,
    ...flags,
    _id: generateLineId(),
  };
};

/**
 * Parses existing env text and rejects unsupported syntax before editing starts.
 */
export const parseEnvText = (text) => {
  lineIdCounter = 0;
  const lines = splitIntoLogicalLines(text).map(parseEnvLine);
  validateEnvLines(lines);
  return lines;
};

/**
 * Validates browser-submitted structured lines before serialization.
 */
export const validateEnvLines = (lines) => {
  if (!Array.isArray(lines)) {
    throw new Error("Environment lines must be an array.");
  }

  const enabledNames = new Set();

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    if (!line || typeof line !== "object") {
      throw new Error(`Line ${lineNumber}: line must be an object.`);
    }

    if (line.type === "blank") return;

    if (line.type === "comment" || line.type === "readonly_comment") {
      const text = typeof line.text === "string" ? line.text : "";
      if (line.type === "comment" && text.includes("=")) {
        throw new Error(`Line ${lineNumber}: comments cannot contain "=".`);
      }
      if (text.includes("\n") || text.includes("\r")) {
        throw new Error(`Line ${lineNumber}: comments cannot contain new lines.`);
      }
      return;
    }

    if (line.type === "variable") {
      const name = typeof line.name === "string" ? line.name : "";
      const value = typeof line.value === "string" ? line.value : String(line.value ?? "");
      if (!ENV_VARIABLE_NAME_PATTERN.test(name)) {
        throw new Error(`Line ${lineNumber}: variable name is invalid.`);
      }
      // Safeguard: prevent users from entering bahotasu flags into the comment field
      if (line.inlineComment) {
        const commentStr = String(line.inlineComment);
        if (/\bbahotasu-secret\b|\bbahotasu-block\b|\bbahotasu-hide\b/.test(commentStr)) {
          throw new Error(`Line ${lineNumber}: inline comment cannot contain system flags.`);
        }
      }
      if (line.enabled !== false && enabledNames.has(name)) {
        throw new Error(`Line ${lineNumber}: duplicate enabled variable "${name}" is not allowed.`);
      }
      if (line.enabled !== false) {
        enabledNames.add(name);
      }
      return;
    }

    throw new Error(`Line ${lineNumber}: unsupported line type.`);
  });
};

const escapeQuotedValue = (value) => String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const serializeValue = (value) => {
  const normalized = String(value ?? "");
  if (NUMBER_LITERAL_PATTERN.test(normalized)) {
    return normalized;
  }
  return `"${escapeQuotedValue(normalized)}"`;
};

const serializeLine = (line) => {
  if (line.type === "blank") return "";
  if (line.type === "readonly_comment") return `#${line.text || ""}`;
  if (line.type === "comment") return `#${line.text || ""}`;
  const prefix = line.enabled === false ? "#" : "";
  let result = `${prefix}${line.name}=${serializeValue(line.value)}`;
  if (line.inlineComment && line.inlineComment.trim()) {
    result += ` # ${line.inlineComment.trim()}`;
  }
  if (line.isSecret) result += " # bahotasu-secret";
  if (line.isBlocked) result += " # bahotasu-block";
  if (line.isHidden) result += " # bahotasu-hide";
  return result;
};

/**
 * Serializes validated structured lines into canonical .env text.
 */
export const serializeEnvLines = (lines) => {
  validateEnvLines(lines);
  if (lines.length === 0) return "";
  return `${lines.map(serializeLine).join("\n")}\n`;
};

const lineLabel = (line) => {
  if (!line) return "";
  if (line.type === "variable") return line.name;
  if (line.type === "comment" || line.type === "readonly_comment") return line.text || "Comment";
  return "Blank line";
};

const maskValue = (line) => {
  if (!line) return "";
  if (line.type === "variable") return line.value === "" ? "(empty)" : "[redacted]";
  if (line.type === "comment" || line.type === "readonly_comment") return line.text || "";
  return "";
};

const normalizeForCompare = (line) => {
  if (!line) return null;
  if (line.type === "variable") {
    return {
      type: "variable",
      name: line.name,
      value: String(line.value ?? ""),
      enabled: line.enabled !== false,
    };
  }
  if (line.type === "comment" || line.type === "readonly_comment") {
    return { type: "comment", text: line.text || "" };
  }
  return { type: "blank" };
};

/**
 * Builds redacted change records for confirmation responses and saved history.
 */
export const buildRedactedChanges = (previousLines, nextLines) => {
  const changes = [];
  const total = Math.max(previousLines.length, nextLines.length);

  for (let index = 0; index < total; index += 1) {
    const before = normalizeForCompare(previousLines[index]);
    const after = normalizeForCompare(nextLines[index]);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;

    const action = before && after ? "updated" : before ? "deleted" : "added";
    changes.push({
      action,
      line: index + 1,
      type: after?.type || before?.type || "unknown",
      label: lineLabel(after || before),
      oldValue: maskValue(before),
      newValue: maskValue(after),
      oldEnabled: before?.type === "variable" ? before.enabled : null,
      newEnabled: after?.type === "variable" ? after.enabled : null,
    });
  }

  return changes;
};

/**
 * Prevents browser JSON from editing or deleting read-only separator comments.
 * These lines preserve existing "# =====" style separators but cannot be changed in the UI.
 */
export const assertReadonlyCommentsUnchanged = (previousLines, nextLines) => {
  previousLines.forEach((line, index) => {
    if (line?.type !== "readonly_comment") return;
    const next = nextLines[index];
    if (!next || next.type !== "readonly_comment" || next.text !== line.text) {
      throw new Error(`Line ${index + 1}: read-only comment separators cannot be changed.`);
    }
  });
};

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

const resolveRemoteServer = (envFile) => {
  if (!envFile.serverId) return null;
  const server = ServerModel.findById(envFile.serverId);
  if (!server) {
    throw new Error("Target server not found.");
  }
  if (ServerModel.isLocalServer(server)) {
    return null;
  }
  return server;
};

const connectRemoteServer = (server) =>
  new Promise((resolve, reject) => {
    const client = new Client();
    const connectConfig = {
      host: server.host,
      port: server.port || 22,
      username: server.username || "root",
      readyTimeout: 10000,
    };

    try {
      if (server.authType === "key") {
        connectConfig.privateKey = decrypt(server.encryptedPrivateKey);
      } else if (server.authType === "password") {
        connectConfig.password = decrypt(server.encryptedPassword);
      } else {
        reject(new Error("Remote environment server must use SSH key or password authentication."));
        return;
      }
    } catch (err) {
      reject(new Error(`Credential decryption failed: ${err.message}`));
      return;
    }

    client.once("ready", () => resolve(client));
    client.once("error", (err) => reject(new Error(`SSH connection error: ${err.message}`)));
    client.connect(connectConfig);
  });

const withRemoteClient = async (server, callback) => {
  const client = await connectRemoteServer(server);
  try {
    return await callback(client);
  } finally {
    client.end();
  }
};

const openSftp = (client) =>
  new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) {
        reject(new Error(`SFTP open failed: ${err.message}`));
        return;
      }
      resolve(sftp);
    });
  });

const sftpReadFile = (sftp, filePath) =>
  new Promise((resolve, reject) => {
    sftp.readFile(filePath, "utf8", (err, data) => {
      if (err) {
        reject(new Error(`Failed to read remote file: ${err.message}`));
        return;
      }
      resolve(String(data));
    });
  });

const sftpWriteFile = (sftp, filePath, text) =>
  new Promise((resolve, reject) => {
    sftp.writeFile(filePath, text, "utf8", (err) => {
      if (err) {
        reject(new Error(`Failed to write remote temp file: ${err.message}`));
        return;
      }
      resolve();
    });
  });

const sftpStat = (sftp, filePath) =>
  new Promise((resolve, reject) => {
    sftp.stat(filePath, (err, stats) => {
      if (err) {
        reject(new Error(`Failed to stat remote file: ${err.message}`));
        return;
      }
      resolve(stats);
    });
  });

const sftpChmod = (sftp, filePath, mode) =>
  new Promise((resolve, reject) => {
    sftp.chmod(filePath, mode, (err) => {
      if (err) {
        reject(new Error(`Failed to chmod remote temp file: ${err.message}`));
        return;
      }
      resolve();
    });
  });

const sftpUnlinkQuietly = (sftp, filePath) =>
  new Promise((resolve) => {
    sftp.unlink(filePath, () => resolve());
  });

const remoteExec = (client, command) =>
  new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) {
        reject(new Error(`SSH exec failed: ${err.message}`));
        return;
      }

      let stderr = "";
      stream.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      stream.on("close", (code) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(stderr || `Remote command exited with code ${code}`));
      });
    });
  });

const readRemoteFile = async (server, filePath) =>
  withRemoteClient(server, async (client) => {
    const sftp = await openSftp(client);
    try {
      return await sftpReadFile(sftp, filePath);
    } catch (err) {
      if (err.message.includes("No such file")) return "";
      throw err;
    }
  });

const writeRemoteFileAtomic = async (server, filePath, text) =>
  withRemoteClient(server, async (client) => {
    const sftp = await openSftp(client);
    let permissions = null;
    try {
      const stats = await sftpStat(sftp, filePath);
      permissions = stats.permissions;
    } catch (_) {
      // File may not exist yet; create it without preserving permissions.
    }

    const tempPath = posixPath.join(
      posixPath.dirname(filePath),
      `.${posixPath.basename(filePath)}.bahotasu-${process.pid}-${Date.now()}.tmp`,
    );

    try {
      await sftpWriteFile(sftp, tempPath, text);
      if (permissions) {
        await sftpChmod(sftp, tempPath, permissions & 0o777);
      }
      await remoteExec(client, `mv -f -- ${shellQuote(tempPath)} ${shellQuote(filePath)}`);
    } catch (err) {
      await sftpUnlinkQuietly(sftp, tempPath);
      throw err;
    }
  });

const readLocalFile = async (filePath) => {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
};

const writeLocalFileAtomic = async (filePath, text) => {
  let fileMode = 0o644;
  try {
    const stats = await fs.stat(filePath);
    fileMode = stats.mode & 0o777;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.bahotasu-${process.pid}-${Date.now()}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, text, { encoding: "utf8", mode: fileMode });
    await fs.chmod(tempPath, fileMode);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
};

/**
 * Merges frontend-submitted lines with the original file's parsed lines.
 * Handles hidden placeholders, blocked lines, and secret unmodified values.
 * Added by Claude Sonnet 4 / 2026-06-12.
 */
export const mergeSubmittedLines = (submittedLines, previousLines) => {
  const prevById = {};
  for (const prev of previousLines) {
    if (prev._id) prevById[prev._id] = prev;
  }

  const merged = [];

  for (const submitted of submittedLines) {
    // Hidden placeholders: restore original data from previous file read
    if (submitted.type === "hidden_placeholder" && submitted._id && prevById[submitted._id]) {
      merged.push({ ...prevById[submitted._id] });
      continue;
    }

    const original = submitted._id ? prevById[submitted._id] : null;

    // Blocked lines: always restore from original (defense-in-depth)
    if (original && (original.isBlocked || submitted.isBlocked)) {
      merged.push({ ...original });
      continue;
    }

    // Secret lines with unmodified value: restore original value
    if (submitted.isSecret && submitted._valueModified !== true && original) {
      merged.push({ ...submitted, value: original.value });
      continue;
    }

    merged.push(submitted);
  }

  // Append any hidden/blocked lines from original that are missing in submitted
  const submittedIds = new Set(submittedLines.map((l) => l._id).filter(Boolean));
  for (const prev of previousLines) {
    if ((prev.isHidden || prev.isBlocked) && prev._id && !submittedIds.has(prev._id)) {
      merged.push({ ...prev });
    }
  }

  return merged;
};

/**
 * Reads raw env text from local disk or the selected remote server.
 */
export const readEnvironmentFileText = async (envFile) => {
  const remoteServer = resolveRemoteServer(envFile);
  if (!remoteServer) {
    return readLocalFile(envFile.filePath);
  }
  return readRemoteFile(remoteServer, envFile.filePath);
};

/**
 * Writes canonical env text back to local disk or the selected remote server.
 */
export const writeEnvironmentFileText = async (envFile, text) => {
  const remoteServer = resolveRemoteServer(envFile);
  if (!remoteServer) {
    await writeLocalFileAtomic(envFile.filePath, text);
    return;
  }
  await writeRemoteFileAtomic(remoteServer, envFile.filePath, text);
};
