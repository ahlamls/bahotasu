import crypto from "node:crypto";
import { Hono } from "hono";
import { renderPage } from "../../lib/viewEngine.js";
import {
  attachSession,
  setSessionCookie,
  clearSessionCookie,
  setRememberCookie,
  REMEMBER_COOKIE,
} from "../../middleware/session.js";
import { parseCookies } from "../../lib/cookies.js";
import {
  UserModel,
  SessionModel,
  LogModel,
  UserGroupModel,
  GroupModel,
  CommandModel,
  ServerModel,
  EnvironmentFileModel,
  EnvironmentFileUpdateModel,
  USER_ROLES,
} from "../../models/index.js";
import { verifyPassword, hashPassword } from "../../lib/password.js";
import {
  clearLogFile,
  LOG_SEARCH_CONTEXT_LINES,
  readLogTail,
  searchLogWithContext,
} from "../../services/logSource.service.js";
import {
  buildRedactedChanges,
  assertReadonlyCommentsUnchanged,
  hashEnvText,
  mergeSubmittedLines,
  parseEnvText,
  readEnvironmentFileText,
  serializeEnvLines,
  writeEnvironmentFileText,
} from "../../services/environmentFile.service.js";

const router = new Hono();

router.use("*", attachSession);

const logoData = {
  icon: "/static/logo-notext.svg",
  text: "/static/text-logo.svg",
  full: "/static/logo.svg",
};

const formatInitials = (name = "") => {
  const parts = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "");
  return parts.join("") || "U";
};

const buildLayoutUser = (user) =>
  user
    ? {
        name: user.name,
        initials: formatInitials(user.name),
        profileUrl: "/profile",
        logoutAction: "/logout",
      }
    : null;

const navItems = [
  { key: "home", label: "Home", href: "/dashboard" },
  { key: "groups", label: "Group", href: "/admin/groups" },
  { key: "users", label: "User", href: "/admin/users" },
  { key: "logs", label: "Logs", href: "/admin/logs" },
  // Environment Management registers safe .env edit targets for group-scoped users.
  // Added by OpenAI Codex GPT-5 / 2026-05-20 for the Environment Variables feature.
  { key: "environments", label: "Environment", href: "/admin/environments" },
  // Server Management is its own menu because servers now back both remote logs and commands.
  // Added by OpenAI Codex GPT-5 / 2026-05-19.
  { key: "servers", label: "Server", href: "/admin/servers" },
  { key: "commands", label: "Commands", href: "/admin/commands" },
];

const SLUG_PATTERN = /^[A-Za-z0-9_]+$/;
const normalizeSlug = (value = "") => value.trim().toLowerCase();

const basePageData = (user, { activeNav } = {}) => {
  const data = {
    year: new Date().getFullYear(),
    currentUser: buildLayoutUser(user),
    logoIconSrc: logoData.icon,
    logoTextSrc: logoData.text,
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

const canAccessLog = (user, log) => {
  if (user.role === USER_ROLES.SUPERADMIN) return true;
  if (!log.groupId) return true;
  return UserGroupModel.isUserInGroup(user.id, log.groupId);
};

const buildDashboardGroups = (user) => {
  const records =
    user.role === USER_ROLES.SUPERADMIN
      ? LogModel.listAll()
      : LogModel.listForUser(user.id);

  const grouped = new Map();
  const ungrouped = [];

  records.forEach((log) => {
    const item = {
      id: log.id,
      name: log.name,
      description: log.description || "",
      filePath: log.filePath,
      serverName: log.serverName || "This Server",
      logUrl: `/logs/${log.id}/view`,
    };
    if (log.groupId) {
      if (!grouped.has(log.groupId)) {
        grouped.set(log.groupId, {
          groupId: log.groupId,
          groupName: log.groupName || "Group",
          groupDescription: log.groupDescription || "",
          logs: [],
        });
      }
      grouped.get(log.groupId).logs.push(item);
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
      groupName: "Other logs",
      groupDescription: "Logs available to everyone.",
      logs: ungrouped,
    });
  }
  return sections;
};

/**
 * Builds command dashboard sections grouped by project group.
 * Same pattern as buildDashboardGroups for logs.
 * Superadmins see all commands; users see commands in their groups + ungrouped.
 */
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

/**
 * Builds Environment Variables dashboard sections grouped by project group.
 * Only active env files are listed for editing; superadmins can manage inactive ones in admin.
 * Added by OpenAI Codex GPT-5 / 2026-05-20.
 */
const buildEnvironmentDashboardGroups = (user) => {
  const records = EnvironmentFileModel.listAvailableForUser(user.id, user.role);

  const grouped = new Map();
  const ungrouped = [];

  records.forEach((envFile) => {
    const item = {
      id: envFile.id,
      title: envFile.title,
      description: envFile.description || "",
      filePath: envFile.filePath,
      serverName: envFile.serverName || "This Server",
      editUrl: `/environments/${envFile.id}/edit`,
      historyUrl: `/environments/${envFile.id}/history`,
    };

    if (envFile.groupId) {
      if (!grouped.has(envFile.groupId)) {
        grouped.set(envFile.groupId, {
          groupId: envFile.groupId,
          groupName: envFile.groupName || "Group",
          environments: [],
        });
      }
      grouped.get(envFile.groupId).environments.push(item);
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
      groupName: "Other environments",
      environments: ungrouped,
    });
  }
  return sections;
};

const loginNoticeFromQuery = (c) => {
  const notice = c.req.query("notice");
  if (notice === "password-updated") {
    return "Password updated. Please log in again.";
  }
  return null;
};

const renderLogin = (c, { error, usernameValue, rememberChecked, notice } = {}) => {
  const cookies = parseCookies(c.req.header("cookie"));
  const rememberCookie =
    typeof rememberChecked === "boolean"
      ? rememberChecked
      : cookies[REMEMBER_COOKIE] === "true";

  const html = renderPage(
    "pages/login",
    {
      pageTitle: "Login",
      year: new Date().getFullYear(),
      csrfToken: getCsrfToken(c),
      rememberChecked: rememberCookie,
      logoSrc: logoData.full,
      error,
      notice,
      usernameValue: usernameValue || "",
    },
    { layout: "layouts/auth" },
  );

  return c.html(html);
};

const renderDashboard = (c) => {
  const user = c.get("currentUser");
  if (!user) return c.redirect("/login");
  const logGroups = buildDashboardGroups(user);
  const commandGroups = buildCommandDashboardGroups(user);
  const environmentGroups = buildEnvironmentDashboardGroups(user);

  const html = renderPage("pages/dashboard", {
    ...basePageData(user, { activeNav: "home" }),
    csrfToken: getCsrfToken(c),
    pageTitle: "Dashboard",
    userName: user.name,
    logGroups,
    hasLogs: logGroups.length > 0,
    commandGroups,
    hasCommands: commandGroups.length > 0,
    environmentGroups,
    hasEnvironments: environmentGroups.length > 0,
  });

  return c.html(html);
};

const renderProfile = (c, state = {}) => {
  const user = state.overrideUser || c.get("currentUser");
  if (!user) return c.redirect("/login");

  const groups = state.groups || UserGroupModel.listGroupsForUser(user.id);

  const html = renderPage("pages/profile", {
    ...basePageData(user),
    csrfToken: getCsrfToken(c),
    pageTitle: "Profile",
    username: user.username,
    email: user.email,
    role: user.role,
    groups,
    hasGroups: groups.length > 0,
    nameValue: state.nameValue ?? user.name,
    nameError: state.nameError,
    nameSuccess: state.nameSuccess,
    passwordError: state.passwordError,
  });

  return c.html(html);
};

const groupNotices = {
  created: "Group created successfully.",
  updated: "Group updated successfully.",
  deleted: "Group deleted successfully.",
};

const userNotices = {
  created: "User created successfully.",
  updated: "User updated successfully.",
  deleted: "User deleted successfully.",
  groups: "User groups updated.",
};

const logNotices = {
  created: "Log registered successfully.",
  updated: "Log updated successfully.",
  deleted: "Log deleted successfully.",
};

const environmentNotices = {
  created: "Environment created successfully.",
  updated: "Environment updated successfully.",
  deleted: "Environment deleted successfully.",
};

const DEFAULT_TAIL_LINES = 1000;
const parseTailLines = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.floor(num);
  if (clamped < 10 || clamped > 10000) return null;
  return clamped;
};

const getCsrfToken = (c) => {
  const token = c.get("csrfToken");
  return typeof token === "string" ? token : "";
};

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

/**
 * Embeds JSON safely into inline scripts by escaping HTML-significant characters.
 * This lets the editor receive structured env lines without using raw env text as input.
 */
const toSafeScriptJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

const renderGroupList = (c, state = {}) => {
  const user = c.get("currentUser");
  const groups = GroupModel.listAll();
  const noticeKey = state.notice || c.req.query("notice");
  const html = renderPage("pages/groups/list", {
    ...basePageData(user, { activeNav: "groups" }),
    csrfToken: getCsrfToken(c),
    pageTitle: "Groups",
    groups,
    notice: groupNotices[noticeKey] || null,
    error: state.error,
  });
  return c.html(html);
};

const renderGroupForm = (c, state = {}) => {
  const user = c.get("currentUser");
  const html = renderPage("pages/groups/form", {
    ...basePageData(user, { activeNav: "groups" }),
    csrfToken: getCsrfToken(c),
    pageTitle: state.title,
    title: state.title,
    formAction: state.formAction,
    submitLabel: state.submitLabel,
    nameValue: state.nameValue || "",
    slugValue: state.slugValue || "",
    descriptionValue: state.descriptionValue || "",
    showSlugField: state.showSlugField ?? false,
    error: state.error,
  });
  return c.html(html);
};

const renderUserList = (c, state = {}) => {
  const user = c.get("currentUser");
  const noticeKey = state.notice || c.req.query("notice");
  const users = UserModel.listAll().map((record) => ({
    ...record,
    canManage: record.role !== USER_ROLES.SUPERADMIN,
  }));
  const html = renderPage("pages/users/list", {
    ...basePageData(user, { activeNav: "users" }),
    csrfToken: getCsrfToken(c),
    pageTitle: "Users",
    users,
    notice: userNotices[noticeKey] || null,
    error: state.error,
  });
  return c.html(html);
};

const renderUserForm = (c, state = {}) => {
  const user = c.get("currentUser");
  const html = renderPage("pages/users/form", {
    ...basePageData(user, { activeNav: "users" }),
    csrfToken: getCsrfToken(c),
    pageTitle: state.title,
    title: state.title,
    formAction: state.formAction,
    submitLabel: state.submitLabel,
    nameValue: state.nameValue || "",
    usernameValue: state.usernameValue || "",
    emailValue: state.emailValue || "",
    credentialsReadOnly: state.credentialsReadOnly || false,
    passwordOptional: state.passwordOptional || false,
    error: state.error,
  });
  return c.html(html);
};

const renderUserGroups = (c, state = {}) => {
  const user = c.get("currentUser");
  const targetUser = state.targetUser;
  if (!targetUser) return c.redirect("/admin/users");
  const allGroups = GroupModel.listAll();
  const assigned = new Set(
    (state.assignedGroups || UserGroupModel.listGroupsForUser(targetUser.id)).map((g) => g.id),
  );
  const noticeKey = state.notice || c.req.query("notice");
  const html = renderPage("pages/users/groups", {
    ...basePageData(user, { activeNav: "users" }),
    csrfToken: getCsrfToken(c),
    pageTitle: "User groups",
    userName: targetUser.name,
    userEmail: targetUser.email,
    formAction: `/admin/users/${targetUser.id}/groups`,
    groups: allGroups.map((group) => ({
      ...group,
      assigned: assigned.has(group.id),
    })),
    hasGroups: allGroups.length > 0,
    notice: userNotices[noticeKey] || null,
    error: state.error,
  });
  return c.html(html);
};

const renderLogList = (c, state = {}) => {
  const user = c.get("currentUser");
  const noticeKey = state.notice || c.req.query("notice");
  const logs = LogModel.listAll().map((log) => ({
    ...log,
    groupLabel: log.groupName || "No group",
    serverLabel: log.serverName || "This Server",
  }));
  const html = renderPage("pages/logs/list", {
    ...basePageData(user, { activeNav: "logs" }),
    csrfToken: getCsrfToken(c),
    pageTitle: "Logs",
    logs,
    notice: logNotices[noticeKey] || null,
    error: state.error,
  });
  return c.html(html);
};

const renderLogForm = (c, state = {}) => {
  const user = c.get("currentUser");
  const selectedGroupId =
    state.groupId === undefined || state.groupId === null ? null : Number(state.groupId);
  const groups = GroupModel.listAll().map((group) => ({
    ...group,
    selected: selectedGroupId !== null && group.id === selectedGroupId,
  }));
  const rawSelectedServerId =
    state.serverId === undefined || state.serverId === null ? null : Number(state.serverId);
  const allServers = ServerModel.listAll();
  const selectedServer = allServers.find((server) => server.id === rawSelectedServerId);
  // Treat the seeded local server the same as NULL so the form preserves the local default.
  // Added by OpenAI Codex GPT-5 / 2026-05-19 for remote log target selection.
  const selectedServerId =
    selectedServer && !ServerModel.isLocalServer(selectedServer) ? selectedServer.id : null;
  const servers = allServers.map((server) => ({
    ...server,
    isRemote: !ServerModel.isLocalServer(server),
    selected: selectedServerId !== null && server.id === selectedServerId,
  }));
  const html = renderPage("pages/logs/form", {
    ...basePageData(user, { activeNav: "logs" }),
    csrfToken: getCsrfToken(c),
    pageTitle: state.title,
    title: state.title,
    formAction: state.formAction,
    submitLabel: state.submitLabel,
    nameValue: state.nameValue || "",
    descriptionValue: state.descriptionValue || "",
    filePathValue: state.filePathValue || "",
    tailLinesValue: state.tailLinesValue || DEFAULT_TAIL_LINES,
    allowClear: !!state.allowClear,
    servers,
    noServerSelected: selectedServerId === null,
    groups,
    noGroupSelected: selectedGroupId === null,
    error: state.error,
  });
  return c.html(html);
};

const renderEnvironmentList = (c, state = {}) => {
  const user = c.get("currentUser");
  const noticeKey = state.notice || c.req.query("notice");
  const environments = EnvironmentFileModel.listAll().map((envFile) => ({
    ...envFile,
    groupLabel: envFile.groupName || "Everyone",
    serverLabel: envFile.serverName || "This Server",
  }));

  const html = renderPage("pages/environments/list", {
    ...basePageData(user, { activeNav: "environments" }),
    csrfToken: getCsrfToken(c),
    pageTitle: "Environment Management",
    environments,
    hasEnvironments: environments.length > 0,
    notice: environmentNotices[noticeKey] || null,
    error: state.error,
  });
  return c.html(html);
};

const renderEnvironmentForm = (c, state = {}) => {
  const user = c.get("currentUser");
  const selectedGroupId =
    state.groupId === undefined || state.groupId === null ? null : Number(state.groupId);
  const groups = GroupModel.listAll().map((group) => ({
    ...group,
    selected: selectedGroupId !== null && group.id === selectedGroupId,
  }));

  const rawSelectedServerId =
    state.serverId === undefined || state.serverId === null ? null : Number(state.serverId);
  const allServers = ServerModel.listAll();
  const selectedServer = allServers.find((server) => server.id === rawSelectedServerId);
  // Local server selections are normalized to NULL so env files follow the same target semantics as logs.
  // Added by OpenAI Codex GPT-5 / 2026-05-20 for Environment Variables.
  const selectedServerId =
    selectedServer && !ServerModel.isLocalServer(selectedServer) ? selectedServer.id : null;
  const servers = allServers.map((server) => ({
    ...server,
    isRemote: !ServerModel.isLocalServer(server),
    selected: selectedServerId !== null && server.id === selectedServerId,
  }));

  const html = renderPage("pages/environments/form", {
    ...basePageData(user, { activeNav: "environments" }),
    csrfToken: getCsrfToken(c),
    pageTitle: state.title,
    title: state.title,
    formAction: state.formAction,
    submitLabel: state.submitLabel,
    titleValue: state.titleValue || "",
    descriptionValue: state.descriptionValue || "",
    filePathValue: state.filePathValue || "",
    isActive: state.isActive !== false,
    servers,
    noServerSelected: selectedServerId === null,
    groups,
    noGroupSelected: selectedGroupId === null,
    error: state.error,
  });
  return c.html(html);
};

const renderEnvironmentHistory = (c, envFile, updates, state = {}) => {
  const user = c.get("currentUser");
  const html = renderPage("pages/environments/history", {
    ...basePageData(user),
    csrfToken: getCsrfToken(c),
    pageTitle: `${envFile.title} · Environment History`,
    environmentTitle: envFile.title,
    environmentDescription: envFile.description || "",
    filePath: envFile.filePath,
    serverLabel: envFile.serverName || "This Server",
    editUrl: `/environments/${envFile.id}/edit`,
    updates: updates.map((update) => ({
      ...update,
      hasChanges: update.changes.length > 0,
      changes: update.changes.map((change) => ({
        ...change,
        enabledLabel:
          change.type === "variable"
            ? change.newEnabled === false
              ? "Disabled"
              : "Enabled"
            : "",
      })),
    })),
    hasUpdates: updates.length > 0,
    error: state.error,
  });
  return c.html(html);
};

const renderLogSearchPage = (c, state = {}) => {
  const user = c.get("currentUser");
  const html = renderPage("pages/logs/search", {
    ...basePageData(user),
    csrfToken: getCsrfToken(c),
    pageTitle: `${state.log?.name || "Log"} · String search`,
    logId: state.log?.id,
    logName: state.log?.name || "",
    filePath: state.log?.filePath || "",
    serverLabel: state.log?.serverName || "This Server",
    viewerUrl: state.log ? `/logs/${state.log.id}/view` : "/dashboard",
    queryValue: state.queryValue || "",
    error: state.error,
    notice: state.notice,
    output: state.output || "",
    hasOutput: !!state.output,
    totalShown: state.totalShown || 0,
  });
  return c.html(html);
};

const ensureGuest = (handler) => (c) => {
  if (c.get("currentUser")) {
    return c.redirect("/dashboard");
  }
  return handler(c);
};

const requireAuth = (handler) => (c) => {
  if (!c.get("currentUser")) {
    return c.redirect("/login");
  }
  return handler(c);
};

const requireSuperAdmin = (handler) =>
  requireAuth((c) => {
    const user = c.get("currentUser");
    if (user?.role !== USER_ROLES.SUPERADMIN) {
      return c.redirect("/dashboard");
    }
    return handler(c);
  });

const sessionMaxAge = (remember) =>
  remember ? 60 * 60 * 24 * 30 : 60 * 60 * 24;

router.get("/", (c) =>
  c.get("currentUser") ? c.redirect("/dashboard") : c.redirect("/login"),
);

router.get(
  "/login",
  ensureGuest((c) =>
    renderLogin(c, {
      notice: loginNoticeFromQuery(c),
    }),
  ),
);

router.post(
  "/login",
  ensureGuest(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const identifier = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const rememberInput = body.remember;
    const remember =
      typeof rememberInput === "string"
        ? ["1", "true", "on", "yes"].includes(rememberInput.toLowerCase())
        : !!rememberInput;

    if (!identifier || !password) {
      return renderLogin(c, {
        error: "Username/email and password are required.",
        usernameValue: identifier,
        rememberChecked: remember,
      });
    }

    const user = UserModel.findByUsernameOrEmail(identifier);
    if (!user || !user.isActive) {
      return renderLogin(c, {
        error: "Invalid credentials.",
        usernameValue: identifier,
        rememberChecked: remember,
      });
    }

    const passwordOk = verifyPassword(password, user.passwordHash);
    if (!passwordOk) {
      return renderLogin(c, {
        error: "Invalid credentials.",
        usernameValue: identifier,
        rememberChecked: remember,
      });
    }

    const session = SessionModel.create({ userId: user.id, remember });
    setSessionCookie(c, session.token, sessionMaxAge(remember));
    setRememberCookie(c, remember);
    UserModel.setLastLogin(user.id);

    return c.redirect("/dashboard");
  }),
);

router.get("/dashboard", requireAuth((c) => renderDashboard(c)));

router.get("/profile", requireAuth((c) => renderProfile(c)));

router.post(
  "/profile/name",
  requireAuth(async (c) => {
    const user = c.get("currentUser");
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const displayName =
      typeof body.displayName === "string" ? body.displayName.trim() : "";

    if (!displayName) {
    return renderProfile(c, {
      nameError: "Name is required.",
      nameValue: displayName,
    });
  }

  const updated = UserModel.updateProfile(user.id, { name: displayName });
  const session = c.get("session");
    if (session) {
      session.user.name = updated.name;
    }
    c.set("currentUser", updated);

    return renderProfile(c, {
      nameSuccess: "Name updated successfully.",
      nameValue: updated.name,
      overrideUser: updated,
    });
  }),
);

router.post(
  "/profile/password",
  requireAuth(async (c) => {
    const user = c.get("currentUser");
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const currentPassword =
      typeof body.currentPassword === "string" ? body.currentPassword : "";
    const newPassword =
      typeof body.newPassword === "string" ? body.newPassword : "";
    const confirmPassword =
      typeof body.confirmPassword === "string" ? body.confirmPassword : "";

    if (!currentPassword || !newPassword || !confirmPassword) {
    return renderProfile(c, {
      passwordError: "All password fields are required.",
    });
  }

    if (newPassword.length < 6) {
    return renderProfile(c, {
      passwordError: "New password must be at least 6 characters.",
    });
  }

    if (newPassword !== confirmPassword) {
    return renderProfile(c, {
      passwordError: "New password confirmation does not match.",
    });
  }

    const userWithPassword = UserModel.findByIdWithPassword(user.id);
    if (!userWithPassword || !verifyPassword(currentPassword, userWithPassword.passwordHash)) {
      return renderProfile(c, {
        passwordError: "Current password is incorrect.",
      });
    }

    const newHash = hashPassword(newPassword);
    UserModel.updatePassword(user.id, newHash);

    const session = c.get("session");
    if (session?.id) {
      SessionModel.deleteById(session.id);
    }
    clearSessionCookie(c);
    setRememberCookie(c, false);

    return c.redirect("/login?notice=password-updated");
  }),
);

router.get("/admin/groups", requireSuperAdmin((c) => renderGroupList(c)));

router.get(
  "/admin/groups/new",
  requireSuperAdmin((c) =>
    renderGroupForm(c, {
      title: "Create group",
      formAction: "/admin/groups",
      submitLabel: "Create",
      showSlugField: true,
    }),
  ),
);

router.post(
  "/admin/groups",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const slugInput = typeof body.slug === "string" ? body.slug : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const slug = normalizeSlug(slugInput);

    if (!name || !slug) {
      return renderGroupForm(c, {
        title: "Create group",
        formAction: "/admin/groups",
        submitLabel: "Create",
        nameValue: name,
        slugValue: slugInput,
        descriptionValue: description,
        showSlugField: true,
        error: "Name and slug are required.",
      });
    }
    if (!SLUG_PATTERN.test(slug)) {
      return renderGroupForm(c, {
        title: "Create group",
        formAction: "/admin/groups",
        submitLabel: "Create",
        nameValue: name,
        slugValue: slugInput,
        descriptionValue: description,
        showSlugField: true,
        error: "Slug must contain only letters, numbers, or underscores.",
      });
    }

    try {
      GroupModel.create({ name, slug, description });
    } catch (error) {
      if (error.message.includes("UNIQUE")) {
        return renderGroupForm(c, {
        title: "Create group",
        formAction: "/admin/groups",
        submitLabel: "Create",
        nameValue: name,
        slugValue: slugInput,
        descriptionValue: description,
        showSlugField: true,
        error: "Slug must be unique.",
      });
      }
      throw error;
    }

    return c.redirect("/admin/groups?notice=created");
  }),
);

router.get(
  "/admin/groups/:id/edit",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const group = GroupModel.findById(id);
    if (!group) {
      return renderGroupList(c, { error: "Group not found." });
    }
    return renderGroupForm(c, {
      title: "Edit group",
      formAction: `/admin/groups/${group.id}`,
      submitLabel: "Save changes",
      nameValue: group.name,
      slugValue: group.slug,
      descriptionValue: group.description,
      showSlugField: false,
    });
  }),
);

router.post(
  "/admin/groups/:id",
  requireSuperAdmin(async (c) => {
    const id = Number(c.req.param("id"));
    const group = GroupModel.findById(id);
    if (!group) {
      return renderGroupList(c, { error: "Group not found." });
    }

    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";

    if (!name) {
      return renderGroupForm(c, {
        title: "Edit group",
        formAction: `/admin/groups/${group.id}`,
        submitLabel: "Save changes",
        nameValue: name,
        slugValue: group.slug,
        descriptionValue: description,
        showSlugField: false,
        error: "Name is required.",
      });
    }

    try {
      GroupModel.update(group.id, { name, description });
    } catch (error) {
      throw error;
    }

    return c.redirect("/admin/groups?notice=updated");
  }),
);

router.post(
  "/admin/groups/:id/delete",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const id = Number(c.req.param("id"));
    const group = GroupModel.findById(id);
    if (!group) {
      return renderGroupList(c, { error: "Group not found." });
    }
    GroupModel.remove(id);
    return c.redirect("/admin/groups?notice=deleted");
  }),
);

router.get("/admin/users", requireSuperAdmin((c) => renderUserList(c)));

router.get(
  "/admin/users/new",
  requireSuperAdmin((c) =>
    renderUserForm(c, {
      title: "Create user",
      formAction: "/admin/users",
      submitLabel: "Create",
    }),
  ),
);

router.post(
  "/admin/users",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

    if (!name || !username || !email || !password) {
      return renderUserForm(c, {
        title: "Create user",
        formAction: "/admin/users",
        submitLabel: "Create",
        nameValue: name,
        usernameValue: username,
        emailValue: email,
        error: "Name, username, email, and password are required.",
      });
    }

    if (password.length < 6) {
      return renderUserForm(c, {
        title: "Create user",
        formAction: "/admin/users",
        submitLabel: "Create",
        nameValue: name,
        usernameValue: username,
        emailValue: email,
        error: "Password must be at least 6 characters.",
      });
    }
    if (password !== confirmPassword) {
      return renderUserForm(c, {
        title: "Create user",
        formAction: "/admin/users",
        submitLabel: "Create",
        nameValue: name,
        usernameValue: username,
        emailValue: email,
        error: "Password confirmation does not match.",
      });
    }

    try {
      const passwordHash = hashPassword(password);
      UserModel.create({ name, username, email, passwordHash, role: USER_ROLES.USER });
    } catch (error) {
      if (error.message.includes("UNIQUE")) {
        return renderUserForm(c, {
          title: "Create user",
          formAction: "/admin/users",
          submitLabel: "Create",
          nameValue: name,
          usernameValue: username,
          emailValue: email,
          error: "Username or email already exists.",
        });
      }
      throw error;
    }

    return c.redirect("/admin/users?notice=created");
  }),
);

router.get(
  "/admin/users/:id/edit",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const target = UserModel.findById(id);
    if (!target) {
      return renderUserList(c, { error: "User not found." });
    }
    if (target.role === USER_ROLES.SUPERADMIN) {
      return renderUserList(c, { error: "Superadmin can only be managed via CLI." });
    }
    return renderUserForm(c, {
      title: "Edit user",
      formAction: `/admin/users/${target.id}`,
      submitLabel: "Save changes",
      nameValue: target.name,
      usernameValue: target.username,
      emailValue: target.email,
      credentialsReadOnly: true,
      passwordOptional: true,
    });
  }),
);

router.post(
  "/admin/users/:id",
  requireSuperAdmin(async (c) => {
    const id = Number(c.req.param("id"));
    const target = UserModel.findById(id);
    if (!target) {
      return renderUserList(c, { error: "User not found." });
    }
    if (target.role === USER_ROLES.SUPERADMIN) {
      return renderUserList(c, { error: "Superadmin can only be managed via CLI." });
    }

    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

    if (!name) {
      return renderUserForm(c, {
        title: "Edit user",
        formAction: `/admin/users/${target.id}`,
        submitLabel: "Save changes",
        nameValue: name,
        usernameValue: target.username,
        emailValue: target.email,
        credentialsReadOnly: true,
        passwordOptional: true,
        error: "Name is required.",
      });
    }

    if (password || confirmPassword) {
      if (password.length < 6) {
        return renderUserForm(c, {
          title: "Edit user",
          formAction: `/admin/users/${target.id}`,
          submitLabel: "Save changes",
          nameValue: name,
          usernameValue: target.username,
          emailValue: target.email,
          credentialsReadOnly: true,
          passwordOptional: true,
          error: "Password must be at least 6 characters.",
        });
      }
      if (password !== confirmPassword) {
        return renderUserForm(c, {
          title: "Edit user",
          formAction: `/admin/users/${target.id}`,
          submitLabel: "Save changes",
          nameValue: name,
          usernameValue: target.username,
          emailValue: target.email,
          credentialsReadOnly: true,
          passwordOptional: true,
          error: "Password confirmation does not match.",
        });
      }
      const passwordHash = hashPassword(password);
      UserModel.updatePassword(target.id, passwordHash);
    }

    UserModel.updateProfile(target.id, { name });

    return c.redirect("/admin/users?notice=updated");
  }),
);

router.get(
  "/admin/users/:id/groups",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const target = UserModel.findById(id);
    if (!target) return renderUserList(c, { error: "User not found." });
    if (target.role === USER_ROLES.SUPERADMIN) {
      return renderUserList(c, { error: "Superadmin already has access to all groups." });
    }
    return renderUserGroups(c, { targetUser: target });
  }),
);

router.post(
  "/admin/users/:id/groups",
  requireSuperAdmin(async (c) => {
    const id = Number(c.req.param("id"));
    const target = UserModel.findById(id);
    if (!target) return renderUserList(c, { error: "User not found." });
    if (target.role === USER_ROLES.SUPERADMIN) {
      return renderUserList(c, { error: "Superadmin already has access to all groups." });
    }

    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const raw = body.groupIds;
    const selected = new Set(
      (Array.isArray(raw) ? raw : raw ? [raw] : []).map((value) => Number(value)),
    );

    const allGroups = GroupModel.listAll();
    const currentAssignments = UserGroupModel.listGroupsForUser(target.id);
    const currentSet = new Set(currentAssignments.map((g) => g.id));

    allGroups.forEach((group) => {
      const has = currentSet.has(group.id);
      const wants = selected.has(group.id);
      if (!has && wants) {
        UserGroupModel.assignUserToGroup({ userId: target.id, groupId: group.id });
      } else if (has && !wants) {
        UserGroupModel.removeUserFromGroup({ userId: target.id, groupId: group.id });
      }
    });

    return c.redirect(`/admin/users/${target.id}/groups?notice=groups`);
  }),
);

router.post(
  "/admin/users/:id/delete",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const id = Number(c.req.param("id"));
    const target = UserModel.findById(id);
    if (!target) {
      return renderUserList(c, { error: "User not found." });
    }
    if (target.role === USER_ROLES.SUPERADMIN) {
      return renderUserList(c, { error: "Superadmin can only be managed via CLI." });
    }
    UserModel.remove(target.id);
    return c.redirect("/admin/users?notice=deleted");
  }),
);

router.get("/admin/environments", requireSuperAdmin((c) => renderEnvironmentList(c)));

router.get(
  "/admin/environments/new",
  requireSuperAdmin((c) =>
    renderEnvironmentForm(c, {
      title: "Create environment",
      formAction: "/admin/environments",
      submitLabel: "Create environment",
      isActive: true,
    }),
  ),
);

router.get("/admin/logs", requireSuperAdmin((c) => renderLogList(c)));

router.get(
  "/admin/logs/new",
  requireSuperAdmin((c) =>
    renderLogForm(c, {
      title: "Register log",
      formAction: "/admin/logs",
      submitLabel: "Create log",
      tailLinesValue: DEFAULT_TAIL_LINES,
      allowClear: false,
    }),
  ),
);

const parseGroupId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const parseServerId = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

/**
 * Normalizes file-target server selection for logs and environments.
 * NULL and the seeded local server both mean local filesystem behavior.
 * Updated by OpenAI Codex GPT-5 / 2026-05-20 for shared environment targets.
 */
const resolveFileServerSelection = (serverId) => {
  if (serverId === null) return { serverId: null };
  const server = ServerModel.findById(serverId);
  if (!server) {
    return { error: "Selected target server does not exist." };
  }
  if (ServerModel.isLocalServer(server)) {
    return { serverId: null };
  }
  return { serverId: server.id };
};

const allowClearFromBody = (raw) => {
  if (typeof raw === "string") {
    return ["1", "true", "on", "yes"].includes(raw.toLowerCase());
  }
  return !!raw;
};

const getAuthorizedLog = (c) => {
  const user = c.get("currentUser");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return { error: c.text("Invalid log id", 400) };
  }
  const log = LogModel.findById(id);
  if (!log) {
    return { error: c.text("Log not found", 404) };
  }
  if (!canAccessLog(user, log)) {
    return { error: c.text("Forbidden", 403) };
  }
  return { log };
};

const activeFromBody = (raw) => {
  if (typeof raw === "string") {
    return ["1", "true", "on", "yes"].includes(raw.toLowerCase());
  }
  return !!raw;
};

const getAuthorizedEnvironment = (c) => {
  const user = c.get("currentUser");
  const id = Number(c.req.param("id"));
  if (!Number.isFinite(id)) {
    return { error: c.text("Invalid environment id", 400) };
  }
  const envFile = EnvironmentFileModel.findById(id);
  if (!envFile) {
    return { error: c.text("Environment not found", 404) };
  }
  if (!EnvironmentFileModel.canAccess(user, envFile)) {
    return { error: c.text("Forbidden", 403) };
  }
  return { envFile };
};

const parseJsonBody = async (c) => {
  try {
    return await c.req.json();
  } catch (_) {
    return null;
  }
};

router.post(
  "/admin/environments",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    const groupId = parseGroupId(body.groupId);
    const rawServerId = parseServerId(body.serverId);
    const serverSelection = resolveFileServerSelection(rawServerId);
    const isActive = activeFromBody(body.isActive);

    if (!title || !filePath) {
      return renderEnvironmentForm(c, {
        title: "Create environment",
        formAction: "/admin/environments",
        submitLabel: "Create environment",
        titleValue: title,
        descriptionValue: description,
        filePathValue: filePath,
        groupId,
        serverId: rawServerId,
        isActive,
        error: "Title and file path are required.",
      });
    }

    if (groupId !== null && !GroupModel.findById(groupId)) {
      return renderEnvironmentForm(c, {
        title: "Create environment",
        formAction: "/admin/environments",
        submitLabel: "Create environment",
        titleValue: title,
        descriptionValue: description,
        filePathValue: filePath,
        groupId,
        serverId: rawServerId,
        isActive,
        error: "Selected group does not exist.",
      });
    }

    if (serverSelection.error) {
      return renderEnvironmentForm(c, {
        title: "Create environment",
        formAction: "/admin/environments",
        submitLabel: "Create environment",
        titleValue: title,
        descriptionValue: description,
        filePathValue: filePath,
        groupId,
        serverId: rawServerId,
        isActive,
        error: serverSelection.error,
      });
    }

    const currentUser = c.get("currentUser");
    EnvironmentFileModel.create({
      serverId: serverSelection.serverId,
      groupId,
      title,
      description,
      filePath,
      isActive,
      createdByUserId: currentUser?.id ?? null,
    });

    return c.redirect("/admin/environments?notice=created");
  }),
);

router.get(
  "/admin/environments/:id/edit",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const envFile = EnvironmentFileModel.findById(id);
    if (!envFile) {
      return renderEnvironmentList(c, { error: "Environment not found." });
    }
    return renderEnvironmentForm(c, {
      title: "Edit environment",
      formAction: `/admin/environments/${envFile.id}`,
      submitLabel: "Save changes",
      titleValue: envFile.title,
      descriptionValue: envFile.description,
      filePathValue: envFile.filePath,
      groupId: envFile.groupId,
      serverId: envFile.serverId,
      isActive: envFile.isActive,
    });
  }),
);

router.post(
  "/admin/environments/:id",
  requireSuperAdmin(async (c) => {
    const id = Number(c.req.param("id"));
    const envFile = EnvironmentFileModel.findById(id);
    if (!envFile) {
      return renderEnvironmentList(c, { error: "Environment not found." });
    }

    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    const groupId = parseGroupId(body.groupId);
    const rawServerId = parseServerId(body.serverId);
    const serverSelection = resolveFileServerSelection(rawServerId);
    const isActive = activeFromBody(body.isActive);

    if (!title || !filePath) {
      return renderEnvironmentForm(c, {
        title: "Edit environment",
        formAction: `/admin/environments/${envFile.id}`,
        submitLabel: "Save changes",
        titleValue: title,
        descriptionValue: description,
        filePathValue: filePath,
        groupId,
        serverId: rawServerId,
        isActive,
        error: "Title and file path are required.",
      });
    }

    if (groupId !== null && !GroupModel.findById(groupId)) {
      return renderEnvironmentForm(c, {
        title: "Edit environment",
        formAction: `/admin/environments/${envFile.id}`,
        submitLabel: "Save changes",
        titleValue: title,
        descriptionValue: description,
        filePathValue: filePath,
        groupId,
        serverId: rawServerId,
        isActive,
        error: "Selected group does not exist.",
      });
    }

    if (serverSelection.error) {
      return renderEnvironmentForm(c, {
        title: "Edit environment",
        formAction: `/admin/environments/${envFile.id}`,
        submitLabel: "Save changes",
        titleValue: title,
        descriptionValue: description,
        filePathValue: filePath,
        groupId,
        serverId: rawServerId,
        isActive,
        error: serverSelection.error,
      });
    }

    EnvironmentFileModel.update(envFile.id, {
      serverId: serverSelection.serverId,
      groupId,
      title,
      description,
      filePath,
      isActive,
    });

    return c.redirect("/admin/environments?notice=updated");
  }),
);

router.post(
  "/admin/environments/:id/delete",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const id = Number(c.req.param("id"));
    const envFile = EnvironmentFileModel.findById(id);
    if (!envFile) {
      return renderEnvironmentList(c, { error: "Environment not found." });
    }
    EnvironmentFileModel.remove(envFile.id);
    return c.redirect("/admin/environments?notice=deleted");
  }),
);

router.get(
  "/environments/:id/edit",
  requireAuth(async (c) => {
    const { envFile, error } = getAuthorizedEnvironment(c);
    if (error) return error;

    const user = c.get("currentUser");
    let lines = [];
    let baseHash = "";
    let loadError = "";

    try {
      const rawText = await readEnvironmentFileText(envFile);
      baseHash = hashEnvText(rawText);
      const allLines = parseEnvText(rawText);

      // Filter hidden lines → placeholders, strip secret values
      lines = allLines.map((line) => {
        if (line.isHidden) {
          return { type: "hidden_placeholder", _id: line._id };
        }
        if (line.isSecret) {
          return { ...line, value: "" };
        }
        return line;
      });
    } catch (err) {
      loadError = `Failed to load environment file: ${err.message}`;
    }

    const html = renderPage("pages/environments/editor", {
      ...basePageData(user),
      csrfToken: getCsrfToken(c),
      pageTitle: `${envFile.title} · Environment Variables`,
      environmentId: envFile.id,
      environmentTitle: envFile.title,
      environmentDescription: envFile.description || "",
      filePath: envFile.filePath,
      serverLabel: envFile.serverName || "This Server",
      historyUrl: `/environments/${envFile.id}/history`,
      baseHash,
      initialLinesJson: toSafeScriptJson(lines),
      loadError,
      canSave: !loadError,
    });
    return c.html(html);
  }),
);

router.get(
  "/environments/:id/history",
  requireAuth((c) => {
    const { envFile, error } = getAuthorizedEnvironment(c);
    if (error) return error;
    const updates = EnvironmentFileUpdateModel.listByEnvironment(envFile.id, { limit: 100 });
    return renderEnvironmentHistory(c, envFile, updates);
  }),
);

router.post(
  "/environments/:id/save",
  requireAuth(async (c) => {
    const { envFile, error } = getAuthorizedEnvironment(c);
    if (error) return error;

    const body = await parseJsonBody(c);
    if (!body) {
      return c.json({ error: "Request body must be JSON." }, 400);
    }
    if (!hasValidCsrfToken(c, body)) {
      return c.json({ error: "Invalid CSRF token." }, 403);
    }

    const user = c.get("currentUser");
    const password = typeof body.password === "string" ? body.password : "";
    if (!password) {
      return c.json({ error: "Your password is required to save this environment." }, 403);
    }
    const userWithPassword = UserModel.findByIdWithPassword(user.id);
    if (!userWithPassword || !verifyPassword(password, userWithPassword.passwordHash)) {
      return c.json({ error: "Incorrect password." }, 403);
    }

    const baseHash = typeof body.baseHash === "string" ? body.baseHash : "";
    let currentText = "";
    let previousLines = [];
    try {
      currentText = await readEnvironmentFileText(envFile);
      previousLines = parseEnvText(currentText);
    } catch (err) {
      return c.json({ error: `Failed to read current environment file: ${err.message}` }, 400);
    }

    const currentHash = hashEnvText(currentText);
    if (baseHash !== currentHash) {
      return c.json(
        {
          error: "Environment file changed after you opened it. Reload before saving.",
          current_hash: currentHash,
        },
        409,
      );
    }

    let nextText = "";
    let nextLines = [];
    try {
      // Merge submitted lines with original file data, preserving hidden/blocked/secret
      const mergedLines = mergeSubmittedLines(body.lines, previousLines);
      nextText = serializeEnvLines(mergedLines);
      nextLines = parseEnvText(nextText);
      assertReadonlyCommentsUnchanged(previousLines, nextLines);
    } catch (err) {
      return c.json({ error: "Environment validation failed.", details: [err.message] }, 400);
    }

    const nextHash = hashEnvText(nextText);
    const changes = buildRedactedChanges(previousLines, nextLines);
    if (changes.length === 0) {
      return c.json({
        success: true,
        updated_at: new Date().toISOString(),
        message: "No environment changes detected.",
        changes: [],
        current_hash: currentHash,
      });
    }

    try {
      await writeEnvironmentFileText(envFile, nextText);
    } catch (err) {
      return c.json({ error: `Failed to write environment file: ${err.message}` }, 500);
    }

    const updatedAt = new Date().toISOString();
    EnvironmentFileUpdateModel.create({
      environmentFileId: envFile.id,
      userId: user.id,
      environmentTitle: envFile.title,
      environmentFilePath: envFile.filePath,
      serverName: envFile.serverName || "This Server",
      previousHash: currentHash,
      currentHash: nextHash,
      changes,
    });

    return c.json({
      success: true,
      updated_at: updatedAt,
      message: `Environment successfully updated on ${updatedAt}`,
      changes,
      current_hash: nextHash,
    });
  }),
);

router.post(
  "/admin/logs",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    const tailLines = parseTailLines(body.tailLines ?? DEFAULT_TAIL_LINES);
    const allowClear = allowClearFromBody(body.allowClear);
    const groupId = parseGroupId(body.groupId);
    const rawServerId = parseServerId(body.serverId);
    const serverSelection = resolveFileServerSelection(rawServerId);

    if (!name || !filePath || tailLines === null) {
      return renderLogForm(c, {
        title: "Register log",
        formAction: "/admin/logs",
        submitLabel: "Create log",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines || DEFAULT_TAIL_LINES,
        allowClear,
        groupId,
        serverId: rawServerId,
        error: "Name, file path, and a valid tail line count are required.",
      });
    }

    if (groupId !== null && !GroupModel.findById(groupId)) {
      return renderLogForm(c, {
        title: "Register log",
        formAction: "/admin/logs",
        submitLabel: "Create log",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines,
        allowClear,
        groupId,
        serverId: rawServerId,
        error: "Selected group does not exist.",
      });
    }

    if (serverSelection.error) {
      return renderLogForm(c, {
        title: "Register log",
        formAction: "/admin/logs",
        submitLabel: "Create log",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines,
        allowClear,
        groupId,
        serverId: rawServerId,
        error: serverSelection.error,
      });
    }

    const currentUser = c.get("currentUser");
    LogModel.create({
      groupId,
      name,
      description,
      filePath,
      tailLines,
      allowClear,
      serverId: serverSelection.serverId,
      createdByUserId: currentUser?.id ?? null,
    });

    return c.redirect("/admin/logs?notice=created");
  }),
);

router.get(
  "/admin/logs/:id/edit",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const log = LogModel.findById(id);
    if (!log) {
      return renderLogList(c, { error: "Log entry not found." });
    }
    return renderLogForm(c, {
      title: "Edit log",
      formAction: `/admin/logs/${log.id}`,
      submitLabel: "Save changes",
      nameValue: log.name,
      descriptionValue: log.description,
      filePathValue: log.filePath,
      tailLinesValue: log.tailLines,
      allowClear: !!log.allowClear,
      groupId: log.groupId,
      serverId: log.serverId,
    });
  }),
);

router.post(
  "/admin/logs/:id",
  requireSuperAdmin(async (c) => {
    const id = Number(c.req.param("id"));
    const log = LogModel.findById(id);
    if (!log) {
      return renderLogList(c, { error: "Log entry not found." });
    }
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    const tailLines = parseTailLines(body.tailLines ?? log.tailLines);
    const allowClear = allowClearFromBody(body.allowClear);
    const groupId = parseGroupId(body.groupId);
    const rawServerId = parseServerId(body.serverId);
    const serverSelection = resolveFileServerSelection(rawServerId);

    if (!name || !filePath || tailLines === null) {
      return renderLogForm(c, {
        title: "Edit log",
        formAction: `/admin/logs/${log.id}`,
        submitLabel: "Save changes",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines || log.tailLines,
        allowClear,
        groupId,
        serverId: rawServerId,
        error: "Name, file path, and a valid tail line count are required.",
      });
    }
    if (groupId !== null && !GroupModel.findById(groupId)) {
      return renderLogForm(c, {
        title: "Edit log",
        formAction: `/admin/logs/${log.id}`,
        submitLabel: "Save changes",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines,
        allowClear,
        groupId,
        serverId: rawServerId,
        error: "Selected group does not exist.",
      });
    }

    if (serverSelection.error) {
      return renderLogForm(c, {
        title: "Edit log",
        formAction: `/admin/logs/${log.id}`,
        submitLabel: "Save changes",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines,
        allowClear,
        groupId,
        serverId: rawServerId,
        error: serverSelection.error,
      });
    }

    LogModel.update(log.id, {
      name,
      description,
      filePath,
      tailLines,
      allowClear,
      groupId,
      serverId: serverSelection.serverId,
    });

    return c.redirect("/admin/logs?notice=updated");
  }),
);

router.post(
  "/admin/logs/:id/delete",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const id = Number(c.req.param("id"));
    const log = LogModel.findById(id);
    if (!log) {
      return renderLogList(c, { error: "Log entry not found." });
    }
    LogModel.remove(id);
    return c.redirect("/admin/logs?notice=deleted");
  }),
);

router.get(
  "/logs/:id/view",
  requireAuth((c) => {
    const { log, error } = getAuthorizedLog(c);
    if (error) return error;
    const user = c.get("currentUser");
    const html = renderPage("pages/logs/viewer", {
      ...basePageData(user),
      csrfToken: getCsrfToken(c),
      pageTitle: `${log.name} · Logs`,
      logId: log.id,
      name: log.name,
      description: log.description,
      groupLabel: log.groupName || "No group",
      groupDescription: log.groupDescription || "",
      filePath: log.filePath,
      serverLabel: log.serverName || "This Server",
      tailLines: log.tailLines,
      allowClear: !!log.allowClear,
    });
    return c.html(html);
  }),
);

router.get(
  "/logs/:id/search",
  requireAuth(async (c) => {
    const { log, error } = getAuthorizedLog(c);
    if (error) return error;

    const queryInput = c.req.query("q");
    const queryValue = typeof queryInput === "string" ? queryInput.trim() : "";

    if (!queryValue) {
      return renderLogSearchPage(c, {
        log,
        queryValue: "",
        notice: "Enter a string to search this full log file.",
      });
    }

    if (queryValue.length > 500) {
      return renderLogSearchPage(c, {
        log,
        queryValue,
        error: "Search query is too long (max 500 characters).",
      });
    }

    try {
      const result = await searchLogWithContext(log, queryValue);
      if (result.totalShown === 0) {
        return renderLogSearchPage(c, {
          log,
          queryValue,
          notice: "No matches found.",
        });
      }

      return renderLogSearchPage(c, {
        log,
        queryValue,
        output: result.output,
        totalShown: result.totalShown,
        notice: `Showing last ${result.totalShown} occurrence(s) with ±${LOG_SEARCH_CONTEXT_LINES} lines.`,
      });
    } catch (err) {
      return renderLogSearchPage(c, {
        log,
        queryValue,
        error: `Failed to search log: ${err.message}`,
      });
    }
  }),
);

router.get(
  "/logs/:id/content",
  requireAuth(async (c) => {
    const { log, error } = getAuthorizedLog(c);
    if (error) return error;
    try {
      const text = await readLogTail(log);
      return c.text(text, 200);
    } catch (err) {
      return c.text(`Failed to read log: ${err.message}`, 500);
    }
  }),
);

router.post(
  "/logs/:id/clear",
  requireAuth(async (c) => {
    if (!hasValidCsrfToken(c)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const { log, error } = getAuthorizedLog(c);
    if (error) return error;
    if (!log.allowClear) {
      return c.text("Clearing disabled for this log.", 403);
    }
    try {
      await clearLogFile(log);
      return c.text("Log cleared.");
    } catch (err) {
      return c.text(`Failed to clear log: ${err.message}`, 500);
    }
  }),
);

router.post(
  "/logout",
  requireAuth(async (c) => {
    const body = await c.req.parseBody();
    if (!hasValidCsrfToken(c, body)) {
      return c.text("Invalid CSRF token.", 403);
    }
    const session = c.get("session");
    if (session?.id) {
      SessionModel.deleteById(session.id);
    }
    clearSessionCookie(c);
    setRememberCookie(c, false);
    return c.redirect("/login");
  }),
);

export const webRoutes = router;
