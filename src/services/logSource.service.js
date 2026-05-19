/**
 * LogSourceService — reads, searches, and clears local or remote log files.
 * Local logs keep the existing Unix command behavior; remote logs reuse SSH
 * sessions through a short-lived pool so auto-refresh does not reconnect every poll.
 *
 * Security note:
 * - Commands remain fixed templates.
 * - File paths and search strings are shell-escaped before remote execution.
 * - Remote credentials are decrypted only in memory when opening an SSH connection.
 *
 * @module src/services/logSource.service
 * @author OpenAI Codex GPT-5 / 2026-05-19
 */

import { spawn } from "node:child_process";
import { Client } from "ssh2";
import { ServerModel } from "../models/index.js";
import { decrypt } from "../lib/encryption.js";

export const LOG_SEARCH_CONTEXT_LINES = 10;
export const LOG_SEARCH_OCCURRENCE_LIMIT = 5;

const REMOTE_IDLE_TTL_MS = 60 * 1000;

const remoteConnectionPool = new Map();

/**
 * Escapes a value for POSIX shell single-quoted usage.
 * This keeps registered file paths and search strings as data, not shell syntax.
 */
const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

/**
 * Validates line numbers before they are interpolated into fixed local/remote commands.
 * Line bounds are numeric-only by construction, so they do not need shell escaping.
 */
const assertPositiveInteger = (value, label) => {
  const num = Number(value);
  if (!Number.isInteger(num) || num < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return num;
};

/**
 * Runs a local command without a shell so existing local log behavior remains unchanged.
 */
const runLocalCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(stderr || `${command} exited with code ${code}`));
    });
  });

/**
 * Closes a pooled SSH connection entry and removes it from the pool.
 * Used for idle timeout, SSH errors, server updates, and graceful shutdown.
 */
const closePoolEntry = (serverId) => {
  const entry = remoteConnectionPool.get(serverId);
  if (!entry) return;

  remoteConnectionPool.delete(serverId);
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  try {
    entry.client.end();
  } catch (_) {
    // Connection is already closing; no additional action needed.
  }
};

/**
 * Schedules idle cleanup after remote log activity stops for this server.
 */
const scheduleIdleClose = (entry) => {
  if (entry.idleTimer) {
    clearTimeout(entry.idleTimer);
  }
  if (entry.activeCount > 0) return;

  entry.idleTimer = setTimeout(() => {
    closePoolEntry(entry.serverId);
  }, REMOTE_IDLE_TTL_MS);
  entry.idleTimer.unref?.();
};

/**
 * Opens or reuses an SSH connection for a remote server.
 * The promise resolves only after ssh2 reports the connection as ready.
 */
const getRemoteConnectionEntry = (server) => {
  const existing = remoteConnectionPool.get(server.id);
  if (existing) {
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    return existing;
  }

  const client = new Client();
  const entry = {
    serverId: server.id,
    client,
    activeCount: 0,
    idleTimer: null,
    readyPromise: null,
  };

  remoteConnectionPool.set(server.id, entry);

  entry.readyPromise = new Promise((resolve, reject) => {
    let settled = false;
    const settleOnce = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    client.once("ready", () => {
      settleOnce(resolve, entry);
    });
    client.once("error", (err) => {
      closePoolEntry(server.id);
      settleOnce(reject, new Error(`SSH connection error: ${err.message}`));
    });
    client.once("close", () => {
      closePoolEntry(server.id);
      if (!settled) {
        settleOnce(reject, new Error("SSH connection closed before it was ready."));
      }
    });

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
        settleOnce(reject, new Error("Remote log server must use SSH key or password authentication."));
        return;
      }
    } catch (err) {
      closePoolEntry(server.id);
      settleOnce(reject, new Error(`Credential decryption failed: ${err.message}`));
      return;
    }

    client.connect(connectConfig);
  });

  return entry;
};

/**
 * Executes a fixed remote shell command over a pooled SSH connection.
 */
const runRemoteCommand = async (server, command) => {
  const entry = getRemoteConnectionEntry(server);
  await entry.readyPromise;
  entry.activeCount += 1;

  try {
    return await new Promise((resolve, reject) => {
      entry.client.exec(command, (err, stream) => {
        if (err) {
          reject(new Error(`SSH exec failed: ${err.message}`));
          return;
        }

        let stdout = "";
        let stderr = "";

        stream.on("data", (chunk) => {
          stdout += chunk.toString();
        });
        stream.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });
        stream.on("close", (code) => {
          if (code === 0) {
            resolve({ stdout, stderr });
            return;
          }
          reject(new Error(stderr || `Remote command exited with code ${code}`));
        });
      });
    });
  } finally {
    entry.activeCount -= 1;
    scheduleIdleClose(entry);
  }
};

/**
 * Resolves the remote server for a log. NULL server_id means local behavior.
 */
const resolveRemoteServer = (log) => {
  if (!log.serverId) return null;
  const server = ServerModel.findById(log.serverId);
  if (!server) {
    throw new Error("Target server not found.");
  }
  if (server.authType === "local") {
    return null;
  }
  return server;
};

const findLastMatchLineNumbersLocal = (filePath, query, limit) =>
  new Promise((resolve, reject) => {
    const proc = spawn("grep", ["-F", "-n", "--", query, filePath], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let remainder = "";
    const lastMatches = [];

    const pushMatch = (line) => {
      const match = /^(\d+):/.exec(line);
      if (!match) return;
      lastMatches.push(Number(match[1]));
      if (lastMatches.length > limit) {
        lastMatches.shift();
      }
    };

    proc.stdout.on("data", (chunk) => {
      remainder += chunk.toString();
      const lines = remainder.split("\n");
      remainder = lines.pop() ?? "";
      lines.forEach(pushMatch);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    proc.on("close", (code) => {
      if (remainder) {
        pushMatch(remainder);
      }
      if (code === 0) {
        resolve(lastMatches);
        return;
      }
      if (code === 1) {
        resolve([]);
        return;
      }
      reject(new Error(stderr || `grep exited with code ${code}`));
    });
  });

const readFileRangeLocal = (filePath, startLine, endLine) =>
  runLocalCommand("sed", ["-n", `${startLine},${endLine}p`, filePath]);

const findLastMatchLineNumbersRemote = async (server, filePath, query, limit) => {
  const command = `(grep -F -n -- ${shellQuote(query)} ${shellQuote(filePath)} || true) | tail -n ${limit}`;
  const result = await runRemoteCommand(server, command);
  if (result.stderr.trim()) {
    throw new Error(result.stderr.trim());
  }
  return result.stdout
    .split("\n")
    .map((line) => /^(\d+):/.exec(line))
    .filter(Boolean)
    .map((match) => Number(match[1]));
};

const readFileRangeRemote = async (server, filePath, startLine, endLine) => {
  const script = `${startLine},${endLine}p`;
  const result = await runRemoteCommand(server, `sed -n ${shellQuote(script)} -- ${shellQuote(filePath)}`);
  return result.stdout;
};

/**
 * Formats a search result block exactly like the previous local-only implementation.
 */
const formatSearchResultBlock = ({ filePath, query, lineNumber, context, occurrence, total }) => {
  const lines = context.replace(/\n$/, "").split("\n");
  const startLine = Math.max(1, lineNumber - LOG_SEARCH_CONTEXT_LINES);
  const formattedLines = lines
    .map((line, index) => {
      const currentLine = startLine + index;
      const marker = currentLine === lineNumber ? ">" : " ";
      return `${marker} ${String(currentLine).padStart(7, " ")} | ${line}`;
    })
    .join("\n");

  return [
    `Occurrence ${occurrence}/${total}`,
    `File: ${filePath}`,
    `Match line: ${lineNumber}`,
    `Query: ${query}`,
    "----------------------------------------",
    formattedLines || "(no content)",
  ].join("\n");
};

/**
 * Reads the configured tail for a local or remote log.
 */
export const readLogTail = async (log) => {
  const lines = assertPositiveInteger(log.tailLines, "Tail lines");
  const remoteServer = resolveRemoteServer(log);
  if (!remoteServer) {
    return runLocalCommand("tail", ["-n", String(lines), log.filePath]);
  }

  const result = await runRemoteCommand(
    remoteServer,
    `tail -n ${lines} -- ${shellQuote(log.filePath)}`,
  );
  if (result.stderr.trim()) {
    throw new Error(result.stderr.trim());
  }
  return result.stdout;
};

/**
 * Clears a local or remote log file by truncating it to zero bytes.
 */
export const clearLogFile = async (log) => {
  const remoteServer = resolveRemoteServer(log);
  if (!remoteServer) {
    await runLocalCommand("truncate", ["-s", "0", log.filePath]);
    return;
  }

  const result = await runRemoteCommand(remoteServer, `truncate -s 0 -- ${shellQuote(log.filePath)}`);
  if (result.stderr.trim()) {
    throw new Error(result.stderr.trim());
  }
};

/**
 * Searches a local or remote log and returns the last matching occurrences with context.
 */
export const searchLogWithContext = async (log, query) => {
  const remoteServer = resolveRemoteServer(log);
  const filePath = log.filePath;
  const matchLines = remoteServer
    ? await findLastMatchLineNumbersRemote(remoteServer, filePath, query, LOG_SEARCH_OCCURRENCE_LIMIT)
    : await findLastMatchLineNumbersLocal(filePath, query, LOG_SEARCH_OCCURRENCE_LIMIT);

  if (matchLines.length === 0) {
    return { totalShown: 0, output: "" };
  }

  const sections = [];
  for (let index = 0; index < matchLines.length; index += 1) {
    const lineNumber = matchLines[index];
    const startLine = Math.max(1, lineNumber - LOG_SEARCH_CONTEXT_LINES);
    const endLine = lineNumber + LOG_SEARCH_CONTEXT_LINES;
    const context = remoteServer
      ? await readFileRangeRemote(remoteServer, filePath, startLine, endLine)
      : await readFileRangeLocal(filePath, startLine, endLine);

    sections.push(
      formatSearchResultBlock({
        filePath,
        query,
        lineNumber,
        context,
        occurrence: index + 1,
        total: matchLines.length,
      }),
    );
  }

  return {
    totalShown: sections.length,
    output: sections.join("\n\n========================================\n\n"),
  };
};

/**
 * Closes one remote log SSH connection, usually after server credential changes.
 */
export const closeRemoteLogConnection = (serverId) => {
  closePoolEntry(Number(serverId));
};

/**
 * Closes all remote log SSH connections during graceful shutdown.
 */
export const closeAllRemoteLogConnections = () => {
  Array.from(remoteConnectionPool.keys()).forEach(closePoolEntry);
};
