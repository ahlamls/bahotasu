/**
 * CommandExecutionModel — CRUD operations for the command_executions table.
 * Tracks every command execution request: pending → running → completed/failed.
 * Used by the worker for queue processing and by the UI for polling/history.
 *
 * @module src/models/commandExecutions
 * @author deepseek-v4-pro / 2026-05-04
 */

import { getDatabaseConnection } from "../db/index.js";

const db = () => getDatabaseConnection();

const baseSelect = `
  ce.id,
  ce.command_id AS commandId,
  ce.user_id AS userId,
  ce.status,
  ce.created_at AS createdAt,
  ce.started_at AS startedAt,
  ce.completed_at AS completedAt,
  ce.exit_code AS exitCode,
  ce.output,
  ce.error_summary AS errorSummary,
  ce.server_id AS serverId,
  ce.command_name AS commandName
`;

const toBool = (value) => value === 1 || value === true;

const STATUS_VALUES = Object.freeze({
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
});

export const EXECUTION_STATUS = STATUS_VALUES;

export const CommandExecutionModel = {
  /**
   * Inserts a new pending execution into the queue.
   * Denormalises server_id and command_name for display after command deletion.
   *
   * @param {Object} params
   * @param {number} params.commandId
   * @param {number} params.userId
   * @param {number|null} params.serverId - Denormalised from command
   * @param {string} params.commandName - Denormalised from command
   */
  create({ commandId, userId, serverId, commandName }) {
    const now = new Date().toISOString();
    const stmt = db().prepare(`
      INSERT INTO command_executions (command_id, user_id, status, created_at, server_id, command_name)
      VALUES (@commandId, @userId, @status, @now, @serverId, @commandName)
    `);
    const result = stmt.run({
      commandId,
      userId,
      status: STATUS_VALUES.PENDING,
      now,
      serverId: serverId || null,
      commandName: commandName || "",
    });
    return this.findById(result.lastInsertRowid);
  },

  /** Finds a single execution by ID */
  findById(id) {
    return db()
      .prepare(`SELECT ${baseSelect} FROM command_executions ce WHERE ce.id = ?`)
      .get(id);
  },

  /**
   * Finds an execution by ID, ensuring the requesting user owns it
   * (or the caller is a superadmin — enforced at route level).
   */
  findByIdAndUser(id, userId) {
    return db()
      .prepare(
        `SELECT ${baseSelect} FROM command_executions ce WHERE ce.id = ? AND ce.user_id = ?`,
      )
      .get(id, userId);
  },

  /**
   * Returns the oldest pending execution for the worker to process.
   * Used as the queue picker (FIFO).
   */
  pickNextPending() {
    return db()
      .prepare(
        `SELECT ${baseSelect} FROM command_executions ce WHERE ce.status = ? ORDER BY ce.created_at ASC LIMIT 1`,
      )
      .get(STATUS_VALUES.PENDING);
  },

  /**
   * Returns execution history for a specific command, scoped to a user.
   * Superadmins get all; regular users get only their own executions.
   * Joins with users table to include the executor's name.
   */
  listByCommand(commandId, { userId, isSuperAdmin = false, limit = 50 } = {}) {
    const whereClauses = ["ce.command_id = ?"];
    const params = [commandId];

    if (!isSuperAdmin) {
      whereClauses.push("ce.user_id = ?");
      params.push(userId);
    }

    return db()
      .prepare(
        `SELECT ${baseSelect}, users.name AS userName
         FROM command_executions ce
         LEFT JOIN users ON users.id = ce.user_id
         WHERE ${whereClauses.join(" AND ")}
         ORDER BY ce.created_at DESC
         LIMIT ?`,
      )
      .all(...params, limit);
  },

  /**
   * Returns all execution history.
   * Superadmins can filter by command, server, user, status.
   * Regular users see only their own executions.
   */
  listAll({ userId, isSuperAdmin = false, filters = {}, limit = 100, offset = 0 } = {}) {
    const whereClauses = [];
    const params = [];

    if (!isSuperAdmin) {
      whereClauses.push("ce.user_id = ?");
      params.push(userId);
    }

    if (filters.commandId !== undefined) {
      whereClauses.push("ce.command_id = ?");
      params.push(filters.commandId);
    }
    if (filters.serverId !== undefined) {
      whereClauses.push("ce.server_id = ?");
      params.push(filters.serverId);
    }
    if (filters.userId !== undefined && isSuperAdmin) {
      whereClauses.push("ce.user_id = ?");
      params.push(filters.userId);
    }
    if (filters.status !== undefined) {
      whereClauses.push("ce.status = ?");
      params.push(filters.status);
    }

    const where = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

    return db()
      .prepare(
        `SELECT ${baseSelect}, users.name AS userName
         FROM command_executions ce
         LEFT JOIN users ON users.id = ce.user_id
         ${where}
         ORDER BY ce.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset);
  },

  /**
   * Marks an execution as running and records the start time.
   * Called by the worker before spawning the command.
   */
  markRunning(id) {
    const now = new Date().toISOString();
    db()
      .prepare(
        `UPDATE command_executions SET status = ?, started_at = ? WHERE id = ? AND status = ?`,
      )
      .run(STATUS_VALUES.RUNNING, now, id, STATUS_VALUES.PENDING);
  },

  /**
   * Marks an execution as completed with exit code and output.
   * Output is truncated to 100KB (102400 chars) with a notice appended.
   *
   * @param {number} id
   * @param {Object} result
   * @param {number} result.exitCode
   * @param {string} result.output - Combined stdout+stderr
   */
  markCompleted(id, { exitCode, output }) {
    const MAX_OUTPUT = 100 * 1024; // 100 KB
    const now = new Date().toISOString();

    let finalOutput = output || "";
    if (finalOutput.length > MAX_OUTPUT) {
      finalOutput =
        finalOutput.substring(0, MAX_OUTPUT) +
        "\n\n[... output truncated at 100 KB ...]";
    }

    db()
      .prepare(
        `UPDATE command_executions SET status = ?, completed_at = ?, exit_code = ?, output = ? WHERE id = ?`,
      )
      .run(STATUS_VALUES.COMPLETED, now, exitCode, finalOutput, id);
  },

  /**
   * Marks an execution as failed with an error summary (first 500 chars).
   *
   * @param {number} id
   * @param {string} errorSummary
   */
  markFailed(id, errorSummary) {
    const MAX_ERROR = 500;
    const now = new Date().toISOString();
    const summary = (errorSummary || "Unknown error").substring(0, MAX_ERROR);

    db()
      .prepare(
        `UPDATE command_executions SET status = ?, completed_at = ?, error_summary = ? WHERE id = ?`,
      )
      .run(STATUS_VALUES.FAILED, now, summary, id);
  },
};
