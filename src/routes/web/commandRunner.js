/**
 * Command Runner Web Routes
 * Provides superadmin management (servers, commands) and user execution flow.
 *
 * Routes:
 *   User-facing:
 *     GET  /commands                                  — Dashboard (grouped command cards)
 *     GET  /commands/history                          — All execution history
 *     POST /commands/:id/execute                      — Submit command for execution (JSON)
 *     GET  /commands/:id/executions/:execution_id      — Poll execution status (JSON)
 *     GET  /commands/:id/history                       — Per-command execution history
 *   Admin (superadmin only):
 *     GET/POST  /admin/servers, /admin/servers/new, /admin/servers/:id... — Server CRUD + test
 *     GET/POST  /admin/commands, /admin/commands/new, /admin/commands/:id... — Command CRUD
 *
 * @module src/routes/web/commandRunner
 * @author deepseek-v4-pro / 2026-05-04
 */

import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { Client } from "ssh2";
import { Hono } from "hono";
import { renderPage } from "../../lib/viewEngine.js";
import { attachSession } from "../../middleware/session.js";
import {
  CommandModel,
  ServerModel,
  CommandExecutionModel,
  EXECUTION_STATUS,
  UserGroupModel,
  GroupModel,
  UserModel,
  USER_ROLES,
} from "../../models/index.js";
import { verifyPassword } from "../../lib/password.js";
import { encrypt, decrypt } from "../../lib/encryption.js";
import { closeRemoteLogConnection } from "../../services/logSource.service.js";

const router = new Hono();

// Attach session middleware so currentUser and csrfToken are available on all routes
router.use("*", attachSession);

// ---------------------------------------------------------------------------
// CSRF helpers (mirrored from web/index.js to avoid circular dependency)
// ---------------------------------------------------------------------------

/**
 * Retrieves the CSRF token attached to the current request context.
 * The token is set by the session middleware (attachSession).
 */
const getCsrfToken = (c) => {
  const token = c.get("csrfToken");
  return typeof token === "string" ? token : "";
};

/**
 * Validates a CSRF token using timing-safe comparison.
 * Checks both form body (_csrf) and header (x-csrf-token).
 */
const hasValidCsrfToken = (c, body) => {
  const expected = getCsrfToken(c);
  if (!expected) return false;

  const bodyToken = body?._csrf;
  const headerToken = c.req.header("x-csrf-token");
  const provided =
    typeof bodyToken === "string"
      ? bodyToken
      : typeof headerToken === "string"
        ? headerToken
        : "";

  if (!provided) return false;

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
};

// ---------------------------------------------------------------------------
// Auth helpers (mirror those in web/index.js for standalone usage)
// ---------------------------------------------------------------------------

const requireAuth = (handler) => (c) => {
  if (!c.get("currentUser")) return c.redirect("/login");
  return handler(c);
};

const requireSuperAdmin = (handler) =>
  requireAuth((c) => {
    const user = c.get("currentUser");
    if (user?.role !== USER_ROLES.SUPERADMIN) return c.redirect("/dashboard");
    return handler(c);
  });

// ---------------------------------------------------------------------------
// Helper: build base page data with superadmin nav (consistent with web/index.js)
// ---------------------------------------------------------------------------

const logoData = {
  icon: "/static/logo-notext.svg",
  text: "/static/text-logo.svg",
  full: "/static/logo.svg",
};

const navItems = [
  { key: "home", label: "Home", href: "/dashboard" },
  { key: "groups", label: "Group", href: "/admin/groups" },
  { key: "users", label: "User", href: "/admin/users" },
  { key: "logs", label: "Logs", href: "/admin/logs" },
  // Environment Management is shared navigation for approved .env file editing.
  // Added by OpenAI Codex GPT-5 / 2026-05-20 for the Environment Variables feature.
  { key: "environments", label: "Environment", href: "/admin/environments" },
  // Server Management is separate because server targets are shared by remote logs and commands.
  // Added by OpenAI Codex GPT-5 / 2026-05-19.
  { key: "servers", label: "Server", href: "/admin/servers" },
  { key: "commands", label: "Commands", href: "/admin/commands" },
];

const basePageData = (user, { activeNav } = {}) => {
  const data = {
    year: new Date().getFullYear(),
    logoIconSrc: logoData.icon,
    logoTextSrc: logoData.text,
    currentUser: user
      ? {
          name: user.name,
          initials: (user.name || "")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((p) => p[0]?.toUpperCase() || "")
            .join("") || "U",
          profileUrl: "/profile",
          logoutAction: "/logout",
        }
      : null,
    csrfToken: "",
  };

  if (user?.role === USER_ROLES.SUPERADMIN) {
    data.superAdminNav = {
      items: navItems.map((item) => ({
        ...item,
        active: item.key === activeNav,
      })),
    };
  }

  return data;
};

// ---------------------------------------------------------------------------
// Helper: build command dashboard groups (same pattern as log dashboard)
// ---------------------------------------------------------------------------

const buildCommandDashboardGroups = (user) => {
  const records = CommandModel.listForUser(user.id, user.role);

  const grouped = new Map();
  const ungrouped = [];

  records.forEach((cmd) => {
    const item = {
      id: cmd.id,
      name: cmd.name,
      description: cmd.description || "",
      serverName: cmd.serverName || "Local",
      passwordRequired: cmd.passwordRequired,
      isActive: cmd.isActive,
    };
    if (cmd.groupId) {
      if (!grouped.has(cmd.groupId)) {
        grouped.set(cmd.groupId, {
          groupId: cmd.groupId,
          groupName: cmd.groupName || "Group",
          commands: [],
        });
      }
      grouped.get(cmd.groupId).commands.push(item);
    } else {
      ungrouped.push(item);
    }
  });

  const sections = Array.from(grouped.values()).sort((a, b) =>
    a.groupName.localeCompare(b.groupName),
  );

  if (ungrouped.length > 0) {
    sections.push({
      groupId: null,
      groupName: "Other commands",
      commands: ungrouped,
    });
  }

  return sections;
};

// ===========================================================================
// USER-FACING ROUTES
// ===========================================================================

// ---- Command Dashboard (card view, grouped by project) --------------------

router.get(
  "/commands",
  requireAuth((c) => {
    const user = c.get("currentUser");
    const dashboardGroups = buildCommandDashboardGroups(user);

    const html = renderPage("pages/commands/dashboard", {
      ...basePageData(user, { activeNav: "commands" }),
      csrfToken: getCsrfToken(c),
      pageTitle: "Commands",
      userName: user.name,
      dashboardGroups,
      hasCommands: dashboardGroups.length > 0,
    });

    return c.html(html);
  }),
);

// ---- Submit command for execution (JSON response for AJAX modal) -----------

router.post(
  "/commands/:id/execute",
  requireAuth(async (c) => {
    const user = c.get("currentUser");
    const commandId = Number(c.req.param("id"));

    // CSRF validation
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.json({ error: "Invalid CSRF token." }, 403);
    }

    // Validate command exists and is active
    const command = CommandModel.findById(commandId);
    if (!command) {
      return c.json({ error: "Command not found." }, 404);
    }
    if (!command.isActive) {
      return c.json({ error: "This command is currently disabled." }, 403);
    }

    // Check access (group-based)
    if (!CommandModel.canAccess(user, command)) {
      return c.json({ error: "You do not have access to this command." }, 403);
    }

    // Re-authentication if password_required
    if (command.passwordRequired) {
      const reauthPassword = typeof body.password === "string" ? body.password : "";
      if (!reauthPassword) {
        return c.json({ error: "Password is required to execute this command." }, 403);
      }

      // Fetch user with password hash for timing-safe verification
      const userWithPass = UserModel.findByIdWithPassword(user.id);
      if (!userWithPass || !verifyPassword(reauthPassword, userWithPass.passwordHash)) {
        return c.json({ error: "Incorrect password." }, 403);
      }
    }

    // Resolve server for denormalisation
    let serverId = command.serverId || null;
    if (!serverId) {
      // If no server assigned, use the local server
      const localServer = ServerModel.findLocalServer();
      if (localServer) serverId = localServer.id;
    }

    // Insert execution into queue
    const execution = CommandExecutionModel.create({
      commandId: command.id,
      userId: user.id,
      serverId,
      commandName: command.name,
    });

    return c.json({
      execution_id: execution.id,
      status: "queued",
    });
  }),
);

// ---- Poll execution status (JSON, called by client-side JS) ----------------

router.get(
  "/commands/:id/executions/:executionId",
  requireAuth((c) => {
    const user = c.get("currentUser");
    const executionId = Number(c.req.param("executionId"));

    const execution = CommandExecutionModel.findById(executionId);
    if (!execution) {
      return c.json({ error: "Execution not found." }, 404);
    }

    // Access control: only the owning user or a superadmin can view
    const isOwner =
      user.role === USER_ROLES.SUPERADMIN || execution.userId === user.id;
    if (!isOwner) {
      return c.json({ error: "Access denied." }, 403);
    }

    return c.json({
      status: execution.status,
      exit_code: execution.exitCode,
      output: execution.output || null,
      error_summary: execution.errorSummary || null,
      started_at: execution.startedAt,
      completed_at: execution.completedAt,
    });
  }),
);

// ---- Execution viewer page (HTML, same pattern as log viewer) --------------

router.get(
  "/commands/:id/executions/:executionId/view",
  requireAuth((c) => {
    const user = c.get("currentUser");
    const executionId = Number(c.req.param("executionId"));

    const execution = CommandExecutionModel.findById(executionId);
    if (!execution) {
      return c.text("Execution not found.", 404);
    }

    // Access control: only the owning user or a superadmin can view
    const isOwner =
      user.role === USER_ROLES.SUPERADMIN || execution.userId === user.id;
    if (!isOwner) {
      return c.text("Access denied.", 403);
    }

    const command = CommandModel.findById(execution.commandId);

    const html = renderPage("pages/commands/execution", {
      ...basePageData(user),
      csrfToken: getCsrfToken(c),
      pageTitle: `Execution · ${execution.commandName || "Command"}`,
      commandName: execution.commandName || command?.name || "Command",
      commandDescription: command?.description || "",
      commandId: Number(c.req.param("id")),
      executionId,
    });

    return c.html(html);
  }),
);

// ---- Per-command execution history -----------------------------------------

router.get(
  "/commands/:id/history",
  requireAuth((c) => {
    const user = c.get("currentUser");
    const commandId = Number(c.req.param("id"));
    const isSuperAdmin = user.role === USER_ROLES.SUPERADMIN;

    const command = CommandModel.findById(commandId);
    if (!command) {
      const html = renderPage("pages/commands/history", {
        ...basePageData(user),
        pageTitle: "Command History",
        error: "Command not found.",
      });
      return c.html(html);
    }

    const executions = CommandExecutionModel.listByCommand(commandId, {
      userId: user.id,
      isSuperAdmin,
      limit: 100,
    });

    const html = renderPage("pages/commands/history", {
      ...basePageData(user),
      pageTitle: `History: ${command.name}`,
      commandName: command.name,
      commandId: command.id,
      isSuperAdmin,
      executions: executions.map((e) => ({
        ...e,
        statusBadge:
          e.status === "completed"
            ? "bg-success"
            : e.status === "failed"
              ? "bg-danger"
              : e.status === "running"
                ? "bg-warning text-dark"
                : "bg-secondary",
      })),
      hasExecutions: executions.length > 0,
    });

    return c.html(html);
  }),
);

// ---- All execution history -------------------------------------------------

router.get(
  "/commands/history",
  requireAuth((c) => {
    const user = c.get("currentUser");
    const isSuperAdmin = user.role === USER_ROLES.SUPERADMIN;

    // Parse optional filters
    const commandIdFilter = c.req.query("commandId");
    const statusFilter = c.req.query("status");

    const filters = {};
    if (commandIdFilter) filters.commandId = Number(commandIdFilter);
    if (statusFilter) filters.status = statusFilter;

    const executions = CommandExecutionModel.listAll({
      userId: user.id,
      isSuperAdmin,
      filters,
      limit: 200,
    });

    // For superadmin filter dropdowns, list all commands and servers
    let allCommands = [];
    let allServers = [];
    if (isSuperAdmin) {
      allCommands = CommandModel.listAll();
      allServers = ServerModel.listAll();
    }

    const html = renderPage("pages/commands/history", {
      ...basePageData(user),
      pageTitle: "Execution History",
      isSuperAdmin,
      executions: executions.map((e) => ({
        ...e,
        statusBadge:
          e.status === "completed"
            ? "bg-success"
            : e.status === "failed"
              ? "bg-danger"
              : e.status === "running"
                ? "bg-warning text-dark"
                : "bg-secondary",
      })),
      hasExecutions: executions.length > 0,
      allCommands: allCommands.map((c) => ({
        id: c.id,
        name: c.name,
        selected: commandIdFilter && Number(commandIdFilter) === c.id,
      })),
      allServers: allServers.map((s) => ({
        id: s.id,
        name: s.name,
      })),
      statusFilter: statusFilter || "",
    });

    return c.html(html);
  }),
);

// ===========================================================================
// SUPERADMIN ROUTES — SERVER MANAGEMENT
// ===========================================================================

// ---- List servers ----------------------------------------------------------

router.get(
  "/admin/servers",
  requireSuperAdmin((c) => {
    const user = c.get("currentUser");
    const servers = ServerModel.listAll();

    const notice = c.req.query("notice");
    const notices = {
      created: "Server created successfully.",
      updated: "Server updated successfully.",
      deleted: "Server deleted successfully.",
    };

    const html = renderPage("pages/servers/list", {
      ...basePageData(user, { activeNav: "servers" }),
      csrfToken: getCsrfToken(c),
      pageTitle: "Servers",
      servers: servers.map((s) => ({
        ...s,
        hostLabel: s.authType === "local" ? "Local" : s.host,
        authTypeLabel:
          s.authType === "local"
            ? "Local"
            : s.authType === "key"
              ? "SSH Key"
              : "Password",
        isLocal: s.authType === "local" && s.host === null,
      })),
      notice: notices[notice] || null,
    });

    return c.html(html);
  }),
);

// ---- Create server form ----------------------------------------------------

router.get(
  "/admin/servers/new",
  requireSuperAdmin((c) => {
    const user = c.get("currentUser");
    const html = renderPage("pages/servers/form", {
      ...basePageData(user, { activeNav: "servers" }),
      csrfToken: getCsrfToken(c),
      pageTitle: "New Server",
      title: "Create Server",
      formAction: "/admin/servers",
      submitLabel: "Create",
      isEdit: false,
    });
    return c.html(html);
  }),
);

// ---- Create server ---------------------------------------------------------

router.post(
  "/admin/servers",
  requireSuperAdmin(async (c) => {
    const user = c.get("currentUser");
    const body = await c.req.parseBody();

    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const host = typeof body.host === "string" ? body.host.trim() : "";
    const port = Number(body.port) || 22;
    const username = typeof body.username === "string" ? body.username.trim() : "root";
    const authType = typeof body.authType === "string" ? body.authType : "local";
    const credential = typeof body.credential === "string" ? body.credential : "";

    const errors = [];
    if (!name) errors.push("Name is required.");
    if (authType !== "local" && !host) errors.push("Host is required for remote servers.");
    if ((authType === "key" || authType === "password") && !credential) {
      errors.push("Credential is required for SSH authentication.");
    }

    if (errors.length > 0) {
      const html = renderPage("pages/servers/form", {
        ...basePageData(user, { activeNav: "servers" }),
        csrfToken: getCsrfToken(c),
        pageTitle: "New Server",
        title: "Create Server",
        formAction: "/admin/servers",
        submitLabel: "Create",
        isEdit: false,
        nameValue: name,
        hostValue: host,
        portValue: port,
        usernameValue: username,
        authTypeValue: authType,
        error: errors.join(" "),
      });
      return c.html(html);
    }

    // Encrypt credentials before storing
    let encryptedPrivateKey = null;
    let encryptedPassword = null;

    if (authType === "key") {
      encryptedPrivateKey = encrypt(credential);
    } else if (authType === "password") {
      encryptedPassword = encrypt(credential);
    }

    ServerModel.create({
      name,
      host: authType === "local" ? null : host,
      port,
      username: authType === "local" ? "root" : username,
      authType,
      encryptedPrivateKey,
      encryptedPassword,
    });

    return c.redirect("/admin/servers?notice=created");
  }),
);

// ---- Edit server form ------------------------------------------------------

router.get(
  "/admin/servers/:id/edit",
  requireSuperAdmin((c) => {
    const user = c.get("currentUser");
    const id = Number(c.req.param("id"));
    const server = ServerModel.findById(id);

    if (!server) {
      return c.redirect("/admin/servers");
    }

    const html = renderPage("pages/servers/form", {
      ...basePageData(user, { activeNav: "servers" }),
      csrfToken: getCsrfToken(c),
      pageTitle: `Edit: ${server.name}`,
      title: "Edit Server",
      formAction: `/admin/servers/${id}`,
      submitLabel: "Save",
      isEdit: true,
      isLocal: server.authType === "local" && server.host === null,
      nameValue: server.name,
      hostValue: server.host || "",
      portValue: server.port,
      usernameValue: server.username || "root",
      authTypeValue: server.authType,
    });
    return c.html(html);
  }),
);

// ---- Update server ---------------------------------------------------------

router.post(
  "/admin/servers/:id",
  requireSuperAdmin(async (c) => {
    const user = c.get("currentUser");
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();

    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }

    const server = ServerModel.findById(id);
    if (!server) return c.redirect("/admin/servers");

    const name = typeof body.name === "string" ? body.name.trim() : server.name;
    const host = typeof body.host === "string" ? body.host.trim() : server.host;
    const port = Number(body.port) || server.port;
    const username = typeof body.username === "string" ? body.username.trim() : server.username || "root";
    const authType = typeof body.authType === "string" ? body.authType : server.authType;
    const credential = typeof body.credential === "string" ? body.credential : "";

    const updateFields = { name, host, port, username, authType };

    // Only update credential if a new one is provided
    if (credential) {
      if (authType === "key") {
        updateFields.encryptedPrivateKey = encrypt(credential);
        updateFields.encryptedPassword = null;
      } else if (authType === "password") {
        updateFields.encryptedPassword = encrypt(credential);
        updateFields.encryptedPrivateKey = null;
      }
    }

    ServerModel.update(id, updateFields);
    // Close pooled remote log SSH sessions so edited credentials/host data are used immediately.
    // Added by OpenAI Codex GPT-5 / 2026-05-19 for remote log support.
    closeRemoteLogConnection(id);

    return c.redirect("/admin/servers?notice=updated");
  }),
);

// ---- Delete server ---------------------------------------------------------

router.post(
  "/admin/servers/:id/delete",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }

    const id = Number(c.req.param("id"));
    const server = ServerModel.findById(id);

    if (!server) return c.redirect("/admin/servers");

    // Prevent deletion of the local "This Server"
    if (ServerModel.isLocalServer(server)) {
      return c.redirect("/admin/servers?error=Cannot delete the local server.");
    }

    ServerModel.remove(id);
    // Drop any pooled remote log SSH session for the deleted server target.
    // Added by OpenAI Codex GPT-5 / 2026-05-19 for remote log support.
    closeRemoteLogConnection(id);
    return c.redirect("/admin/servers?notice=deleted");
  }),
);

// ---- Test server connection (JSON) -----------------------------------------

router.post(
  "/admin/servers/:id/test",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.json({ success: false, message: "Invalid CSRF token." }, 403);
    }

    const id = Number(c.req.param("id"));
    const server = ServerModel.findById(id);

    if (!server) {
      return c.json({ success: false, message: "Server not found." });
    }

    try {
      // Local server — spawn echo
      if (server.authType === "local") {
        const result = await new Promise((resolve) => {
          const proc = spawn("/bin/sh", ["-c", "echo OK"], { stdio: ["ignore", "pipe", "pipe"] });
          let out = "";
          proc.stdout.on("data", (d) => (out += d.toString()));
          proc.on("close", (code) => resolve({ code, out: out.trim() }));
        });
        return c.json({
          success: result.code === 0,
          message: result.code === 0 ? `OK — ${result.out}` : `Failed with exit code ${result.code}`,
        });
      }

      // Remote server — SSH echo
      const sshResult = await new Promise((resolve) => {
        const conn = new Client();
        const timeout = setTimeout(() => {
          conn.end();
          resolve({ success: false, message: "Connection timed out." });
        }, 10000);

        const connectConfig = {
          host: server.host,
          port: server.port || 22,
          username: server.username || "root",
          readyTimeout: 8000,
        };

        try {
          if (server.authType === "key") {
            connectConfig.privateKey = decrypt(server.encryptedPrivateKey);
          } else if (server.authType === "password") {
            connectConfig.password = decrypt(server.encryptedPassword);
          }
        } catch (err) {
          clearTimeout(timeout);
          resolve({ success: false, message: `Credential decryption failed: ${err.message}` });
          return;
        }

        conn.on("ready", () => {
          conn.exec("echo OK", (err, stream) => {
            if (err) {
              clearTimeout(timeout);
              conn.end();
              resolve({ success: false, message: `SSH exec failed: ${err.message}` });
              return;
            }
            let out = "";
            stream.on("data", (d) => (out += d.toString()));
            stream.on("close", (code) => {
              clearTimeout(timeout);
              conn.end();
              resolve({
                success: code === 0,
                message: code === 0 ? `OK — ${out.trim()}` : `Failed with exit code ${code}`,
              });
            });
          });
        });

        conn.on("error", (err) => {
          clearTimeout(timeout);
          try { conn.end(); } catch (_) {}
          resolve({ success: false, message: `SSH connection error: ${err.message}` });
        });

        conn.connect(connectConfig);
      });

      return c.json(sshResult);
    } catch (err) {
      return c.json({ success: false, message: err.message });
    }
  }),
);

// ===========================================================================
// SUPERADMIN ROUTES — COMMAND MANAGEMENT
// ===========================================================================

// ---- List commands ---------------------------------------------------------

router.get(
  "/admin/commands",
  requireSuperAdmin((c) => {
    const user = c.get("currentUser");
    const commands = CommandModel.listAll();

    const notice = c.req.query("notice");
    const notices = {
      created: "Command created successfully.",
      updated: "Command updated successfully.",
      deleted: "Command deleted successfully.",
    };

    const html = renderPage("pages/commands/list", {
      ...basePageData(user, { activeNav: "commands" }),
      csrfToken: getCsrfToken(c),
      pageTitle: "Commands",
      commands: commands.map((cmd) => ({
        ...cmd,
        serverLabel: cmd.serverName || "Local",
        groupLabel: cmd.groupName || "Everyone",
      })),
      notice: notices[notice] || null,
    });

    return c.html(html);
  }),
);

// ---- Create command form ---------------------------------------------------

router.get(
  "/admin/commands/new",
  requireSuperAdmin((c) => {
    const user = c.get("currentUser");
    const servers = ServerModel.listAll();
    const groups = GroupModel.listAll();

    const html = renderPage("pages/commands/form", {
      ...basePageData(user, { activeNav: "commands" }),
      csrfToken: getCsrfToken(c),
      pageTitle: "New Command",
      title: "Create Command",
      formAction: "/admin/commands",
      submitLabel: "Create",
      isEdit: false,
      servers: servers.map((s) => ({
        ...s,
        selected: s.authType === "local" && s.host === null,
      })),
      groups: groups.map((g) => ({ ...g, selected: false })),
    });
    return c.html(html);
  }),
);

// ---- Create command --------------------------------------------------------

router.post(
  "/admin/commands",
  requireSuperAdmin(async (c) => {
    const user = c.get("currentUser");
    const body = await c.req.parseBody();

    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const command = typeof body.command === "string" ? body.command.trim() : "";
    const serverId = body.serverId ? Number(body.serverId) : null;
    const groupId = body.groupId ? Number(body.groupId) : null;
    const passwordRequired = body.passwordRequired === "1" || body.passwordRequired === "true" || body.passwordRequired === "on";
    const isActive = body.isActive !== "0" && body.isActive !== "false"; // Default true

    const servers = ServerModel.listAll();
    const groups = GroupModel.listAll();

    const errors = [];
    if (!name) errors.push("Name is required.");
    if (!command) errors.push("Command is required.");

    if (errors.length > 0) {
      const html = renderPage("pages/commands/form", {
        ...basePageData(user, { activeNav: "commands" }),
        csrfToken: getCsrfToken(c),
        pageTitle: "New Command",
        title: "Create Command",
        formAction: "/admin/commands",
        submitLabel: "Create",
        isEdit: false,
        nameValue: name,
        descriptionValue: description,
        commandValue: command,
        passwordRequired,
        isActive,
        servers: servers.map((s) => ({
          ...s,
          selected: serverId ? s.id === serverId : (s.authType === "local" && s.host === null),
        })),
        groups: groups.map((g) => ({ ...g, selected: groupId === g.id })),
        noGroupSelected: !groupId,
        error: errors.join(" "),
      });
      return c.html(html);
    }

    CommandModel.create({
      serverId,
      groupId,
      name,
      description,
      command,
      passwordRequired,
      isActive,
      createdByUserId: user.id,
    });

    return c.redirect("/admin/commands?notice=created");
  }),
);

// ---- Edit command form -----------------------------------------------------

router.get(
  "/admin/commands/:id/edit",
  requireSuperAdmin((c) => {
    const user = c.get("currentUser");
    const id = Number(c.req.param("id"));
    const command = CommandModel.findById(id);

    if (!command) return c.redirect("/admin/commands");

    const servers = ServerModel.listAll();
    const groups = GroupModel.listAll();

    const html = renderPage("pages/commands/form", {
      ...basePageData(user, { activeNav: "commands" }),
      csrfToken: getCsrfToken(c),
      pageTitle: `Edit: ${command.name}`,
      title: "Edit Command",
      formAction: `/admin/commands/${id}`,
      submitLabel: "Save",
      isEdit: true,
      nameValue: command.name,
      descriptionValue: command.description || "",
      commandValue: command.command,
      passwordRequired: command.passwordRequired,
      isActive: command.isActive,
      servers: servers.map((s) => ({
        ...s,
        selected: command.serverId === s.id,
      })),
      groups: groups.map((g) => ({
        ...g,
        selected: command.groupId === g.id,
      })),
      noGroupSelected: !command.groupId,
    });
    return c.html(html);
  }),
);

// ---- Update command --------------------------------------------------------

router.post(
  "/admin/commands/:id",
  requireSuperAdmin(async (c) => {
    const user = c.get("currentUser");
    const id = Number(c.req.param("id"));
    const body = await c.req.parseBody();

    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }

    const command = CommandModel.findById(id);
    if (!command) return c.redirect("/admin/commands");

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const commandStr = typeof body.command === "string" ? body.command.trim() : "";
    const serverId = body.serverId ? Number(body.serverId) : null;
    const groupId = body.groupId ? Number(body.groupId) : null;
    const passwordRequired = body.passwordRequired === "1" || body.passwordRequired === "true" || body.passwordRequired === "on";
    const isActive = body.isActive === "1" || body.isActive === "true" || body.isActive === "on";

    if (!name || !commandStr) {
      const servers = ServerModel.listAll();
      const groups = GroupModel.listAll();
      const html = renderPage("pages/commands/form", {
        ...basePageData(user, { activeNav: "commands" }),
        csrfToken: getCsrfToken(c),
        pageTitle: `Edit: ${command.name}`,
        title: "Edit Command",
        formAction: `/admin/commands/${id}`,
        submitLabel: "Save",
        isEdit: true,
        nameValue: name,
        descriptionValue: description,
        commandValue: commandStr,
        passwordRequired,
        isActive,
        servers: servers.map((s) => ({ ...s, selected: serverId === s.id })),
        groups: groups.map((g) => ({ ...g, selected: groupId === g.id })),
        noGroupSelected: !groupId,
        error: "Name and command are required.",
      });
      return c.html(html);
    }

    CommandModel.update(id, {
      serverId,
      groupId,
      name,
      description,
      command: commandStr,
      passwordRequired,
      isActive,
    });

    return c.redirect("/admin/commands?notice=updated");
  }),
);

// ---- Delete command --------------------------------------------------------

router.post(
  "/admin/commands/:id/delete",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }

    const id = Number(c.req.param("id"));
    const command = CommandModel.findById(id);
    if (!command) return c.redirect("/admin/commands");

    CommandModel.remove(id);
    return c.redirect("/admin/commands?notice=deleted");
  }),
);

export { router as commandRunnerRoutes };
