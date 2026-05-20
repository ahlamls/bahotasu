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
 */
const parseEnvLine = (line, index) => {
  const lineNumber = index + 1;
  const trimmedLine = line.trim();
  if (trimmedLine === "") {
    return { type: "blank" };
  }

  if (trimmedLine.startsWith("#")) {
    // Existing files may indent comments or disabled variables; the editor
    // normalizes them back to leading "#" when saving.
    const body = trimmedLine.slice(1);
    if (body.includes("=")) {
      const separatorIndex = body.indexOf("=");
      // Existing env files may contain "KEY = value"; normalize it on parse so
      // saving rewrites the file to canonical "KEY=value" formatting.
      const name = body.slice(0, separatorIndex).trim();
      const rawValue = body.slice(separatorIndex + 1);
      if (!ENV_VARIABLE_NAME_PATTERN.test(name)) {
        throw new Error(`Line ${lineNumber}: disabled variable name is invalid.`);
      }
      return {
        type: "variable",
        name,
        value: parseValue(rawValue, lineNumber),
        enabled: false,
      };
    }
    return { type: "comment", text: body };
  }

  if (!trimmedLine.includes("=")) {
    throw new Error(`Line ${lineNumber}: non-comment lines must use KEY=value.`);
  }

  const separatorIndex = trimmedLine.indexOf("=");
  // Accept whitespace around "=" in existing files, then serialize without it.
  // Updated by OpenAI Codex GPT-5 / 2026-05-20 for tolerant env-file loading.
  const name = trimmedLine.slice(0, separatorIndex).trim();
  const rawValue = trimmedLine.slice(separatorIndex + 1);
  if (!ENV_VARIABLE_NAME_PATTERN.test(name)) {
    throw new Error(`Line ${lineNumber}: variable name is invalid.`);
  }

  return {
    type: "variable",
    name,
    value: parseValue(rawValue, lineNumber),
    enabled: true,
  };
};

/**
 * Parses existing env text and rejects unsupported syntax before editing starts.
 */
export const parseEnvText = (text) => {
  const lines = splitEnvLines(text).map(parseEnvLine);
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

    if (line.type === "comment") {
      const text = typeof line.text === "string" ? line.text : "";
      if (text.includes("=")) {
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
      if (value.includes("\n") || value.includes("\r")) {
        throw new Error(`Line ${lineNumber}: variable values cannot contain new lines.`);
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
  if (line.type === "comment") return `#${line.text || ""}`;
  const prefix = line.enabled === false ? "#" : "";
  return `${prefix}${line.name}=${serializeValue(line.value)}`;
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
  if (line.type === "comment") return line.text || "Comment";
  return "Blank line";
};

const maskValue = (line) => {
  if (!line) return "";
  if (line.type === "variable") return line.value === "" ? "(empty)" : "[redacted]";
  if (line.type === "comment") return line.text || "";
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
  if (line.type === "comment") {
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
    return sftpReadFile(sftp, filePath);
  });

const writeRemoteFileAtomic = async (server, filePath, text) =>
  withRemoteClient(server, async (client) => {
    const sftp = await openSftp(client);
    const stats = await sftpStat(sftp, filePath);
    const tempPath = posixPath.join(
      posixPath.dirname(filePath),
      `.${posixPath.basename(filePath)}.bahotasu-${process.pid}-${Date.now()}.tmp`,
    );

    try {
      await sftpWriteFile(sftp, tempPath, text);
      if (stats.permissions) {
        await sftpChmod(sftp, tempPath, stats.permissions & 0o777);
      }
      await remoteExec(client, `mv -f -- ${shellQuote(tempPath)} ${shellQuote(filePath)}`);
    } catch (err) {
      await sftpUnlinkQuietly(sftp, tempPath);
      throw err;
    }
  });

const readLocalFile = (filePath) => fs.readFile(filePath, "utf8");

const writeLocalFileAtomic = async (filePath, text) => {
  const stats = await fs.stat(filePath);
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.bahotasu-${process.pid}-${Date.now()}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, text, { encoding: "utf8", mode: stats.mode & 0o777 });
    await fs.chmod(tempPath, stats.mode & 0o777);
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
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
