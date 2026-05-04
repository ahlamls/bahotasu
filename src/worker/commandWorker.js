/**
 * Command Worker — in-process background queue processor.
 * Polls the command_executions table every 1 second for pending jobs.
 * Processes one execution at a time (single-threaded, lock-guarded).
 * Supports local execution (child_process.spawn) and remote SSH (ssh2).
 *
 * SSH credentials are decrypted at runtime from the servers table.
 * Commands that exceed commandTimeoutSec are killed and marked failed.
 *
 * @module src/worker/commandWorker
 * @author deepseek-v4-pro / 2026-05-04
 */

import { spawn } from "node:child_process";
import { Client } from "ssh2";
import { CommandExecutionModel, ServerModel, CommandModel } from "../models/index.js";
import { decrypt } from "../lib/encryption.js";
import { appConfig } from "../config/env.js";

const POLL_INTERVAL_MS = 1000;
const MAX_OUTPUT = 100 * 1024; // 100 KB

let timer = null;
let isRunning = false; // Lock to prevent concurrent execution

/**
 * Executes a command locally on the Node.js host using child_process.spawn.
 * Runs the command via /bin/sh -c to support shell syntax (pipes, redirects, etc.).
 *
 * @param {string} command - Shell command string to execute
 * @param {number} timeoutMs - Max execution time before kill
 * @returns {Promise<{exitCode: number, output: string}>}
 */
const executeLocal = (command, timeoutMs) =>
  new Promise((resolve) => {
    const proc = spawn("/bin/sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      // Force kill after 2 seconds if SIGTERM doesn't work
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch (_) { /* already dead */ }
      }, 2000);
    }, timeoutMs);

    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (exitCode) => {
      clearTimeout(timeout);
      const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
      const output = combined.length > MAX_OUTPUT
        ? combined.substring(0, MAX_OUTPUT) + "\n\n[... output truncated at 100 KB ...]"
        : combined;

      if (timedOut) {
        resolve({
          exitCode: -1,
          output,
          errorSummary: `Command timed out after ${timeoutMs / 1000}s`,
        });
      } else {
        resolve({ exitCode: exitCode ?? -1, output });
      }
    });
  });

/**
 * Executes a command on a remote server via SSH using the ssh2 library.
 * Connects with either private key or password authentication.
 * Credentials are decrypted from the servers table at runtime.
 *
 * @param {Object} server - Server record from DB (with encrypted credentials)
 * @param {string} command - Shell command to execute
 * @param {number} timeoutMs - Max execution time before kill
 * @returns {Promise<{exitCode: number, output: string, errorSummary?: string}>}
 */
const executeSSH = (server, command, timeoutMs) =>
  new Promise((resolve) => {
    const conn = new Client();
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      try { conn.end(); } catch (_) { /* already closed */ }
    }, timeoutMs);

    const connectConfig = {
      host: server.host,
      port: server.port || 22,
      readyTimeout: 10000,
    };

    // Decrypt and provide the appropriate credential
    if (server.authType === "key") {
      try {
        connectConfig.privateKey = decrypt(server.encryptedPrivateKey);
      } catch (err) {
        resolve({ exitCode: -1, output: "", errorSummary: `SSH key decryption failed: ${err.message}` });
        return;
      }
    } else if (server.authType === "password") {
      try {
        connectConfig.password = decrypt(server.encryptedPassword);
      } catch (err) {
        resolve({ exitCode: -1, output: "", errorSummary: `SSH password decryption failed: ${err.message}` });
        return;
      }
    }

    conn.on("ready", () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          resolve({ exitCode: -1, output: "", errorSummary: `SSH exec error: ${err.message}` });
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

        stream.on("close", (code, signal) => {
          clearTimeout(timeout);
          conn.end();

          const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : "");
          const output = combined.length > MAX_OUTPUT
            ? combined.substring(0, MAX_OUTPUT) + "\n\n[... output truncated at 100 KB ...]"
            : combined;

          if (timedOut) {
            resolve({
              exitCode: -1,
              output,
              errorSummary: `Command timed out after ${timeoutMs / 1000}s`,
            });
          } else {
            const exitCode = code ?? (signal ? -1 : 0);
            resolve({
              exitCode,
              output,
              errorSummary: exitCode !== 0 && !signal
                ? `Command exited with code ${exitCode}`
                : (signal ? `Command terminated by signal ${signal}` : undefined),
            });
          }
        });
      });
    });

    conn.on("error", (err) => {
      clearTimeout(timeout);
      try { conn.end(); } catch (_) { /* already closed */ }
      resolve({ exitCode: -1, output: "", errorSummary: `SSH connection error: ${err.message}` });
    });

    conn.connect(connectConfig);
  });

/**
 * Processes a single pending execution.
 * 1. Marks it as running
 * 2. Resolves the target server (local or SSH)
 * 3. Executes the command
 * 4. Marks completed or failed based on result
 *
 * @param {Object} execution - The execution row from command_executions
 */
const processExecution = async (execution) => {
  CommandExecutionModel.markRunning(execution.id);

  // Resolve the command to get the full command string
  const command = CommandModel.findById(execution.commandId);

  if (!command) {
    CommandExecutionModel.markFailed(execution.id, "Command not found (may have been deleted).");
    return;
  }

  if (!command.isActive) {
    CommandExecutionModel.markFailed(execution.id, "Command is disabled.");
    return;
  }

  const timeoutMs = appConfig.commandTimeoutSec * 1000;
  let result;

  if (!execution.serverId) {
    // No server assigned — execute locally
    result = await executeLocal(command.command, timeoutMs);
  } else {
    // Resolve the server to determine local vs SSH
    const server = ServerModel.findById(execution.serverId);

    if (!server) {
      CommandExecutionModel.markFailed(execution.id, "Target server not found.");
      return;
    }

    if (server.authType === "local") {
      result = await executeLocal(command.command, timeoutMs);
    } else {
      result = await executeSSH(server, command.command, timeoutMs);
    }
  }

  if (result.errorSummary) {
    CommandExecutionModel.markFailed(execution.id, result.errorSummary);
  } else {
    CommandExecutionModel.markCompleted(execution.id, {
      exitCode: result.exitCode,
      output: result.output,
    });
  }
};

/**
 * Main polling loop. Picks the oldest pending execution and processes it.
 * Guarded by the isRunning lock to enforce single-threaded execution.
 */
const poll = () => {
  if (isRunning) return;

  const execution = CommandExecutionModel.pickNextPending();
  if (!execution) return;

  isRunning = true;
  processExecution(execution)
    .catch((err) => {
      console.error("[worker] Unhandled error processing execution", execution.id, err);
      try {
        CommandExecutionModel.markFailed(execution.id, `Internal worker error: ${err.message}`);
      } catch (dbErr) {
        console.error("[worker] Failed to mark execution as failed after error", dbErr);
      }
    })
    .finally(() => {
      isRunning = false;
    });
};

/**
 * Starts the background worker. Polls every POLL_INTERVAL_MS milliseconds.
 * Safe to call multiple times — only one interval is maintained.
 */
export const startWorker = () => {
  if (timer) {
    console.warn("[worker] Worker already running, ignoring duplicate start.");
    return;
  }

  console.log("[worker] Starting command execution worker (poll interval: 1s)");
  timer = setInterval(poll, POLL_INTERVAL_MS);
  timer.unref(); // Don't keep the process alive solely for the timer
};

/**
 * Stops the worker. Use for graceful shutdowns.
 */
export const stopWorker = () => {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("[worker] Worker stopped.");
  }
};
