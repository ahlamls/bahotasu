import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
import { UserModel, SessionModel, LogModel, UserGroupModel, GroupModel, USER_ROLES } from "../../models/index.js";
import { verifyPassword, hashPassword } from "../../lib/password.js";

const router = new Hono();

router.use("*", attachSession);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const resourcePath = (...segments) =>
  path.join(__dirname, "..", "..", "..", "resources", ...segments);

const inlineSvg = (file) => {
  try {
    const svg = fs.readFileSync(resourcePath(file), "utf8");
    const encoded = Buffer.from(svg).toString("base64");
    return `data:image/svg+xml;base64,${encoded}`;
  } catch (err) {
    console.warn(`[web] Failed to load ${file}`, err);
    return "";
  }
};

const logoData = {
  icon: inlineSvg("logo-notext.svg"),
  text: inlineSvg("text-logo.svg"),
  full: inlineSvg("logo.svg"),
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
  { key: "groups", label: "Group Management", href: "/groups" },
  { key: "users", label: "User Management", href: "/users" },
  { key: "logs", label: "Logs Management", href: "/logs" },
];

const SLUG_PATTERN = /^[A-Za-z0-9_]+$/;
const normalizeSlug = (value = "") => value.trim().toLowerCase();

const basePageData = (user, { activeNav } = {}) => {
  const data = {
    year: new Date().getFullYear(),
    currentUser: buildLayoutUser(user),
    logoIconSrc: logoData.icon,
    logoTextSrc: logoData.text,
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
  const dashboardGroups = buildDashboardGroups(user);

  const html = renderPage("pages/dashboard", {
    ...basePageData(user, { activeNav: "home" }),
    pageTitle: "Dashboard",
    userName: user.name,
    dashboardGroups,
    hasLogs: dashboardGroups.length > 0,
  });

  return c.html(html);
};

const renderProfile = (c, state = {}) => {
  const user = state.overrideUser || c.get("currentUser");
  if (!user) return c.redirect("/login");

  const groups = state.groups || UserGroupModel.listGroupsForUser(user.id);

  const html = renderPage("pages/profile", {
    ...basePageData(user),
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

const DEFAULT_TAIL_LINES = 1000;
const parseTailLines = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.floor(num);
  if (clamped < 10 || clamped > 10000) return null;
  return clamped;
};

const runTail = (filePath, lines) =>
  new Promise((resolve, reject) => {
    const tail = spawn("tail", ["-n", String(lines), filePath], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    tail.stdout.on("data", (chunk) => {
      out += chunk.toString();
    });
    tail.stderr.on("data", (chunk) => {
      err += chunk.toString();
    });
    tail.on("close", (code) => {
      if (code === 0) {
        resolve(out);
      } else {
        reject(new Error(err || `tail exited with code ${code}`));
      }
    });
  });

const truncateFile = (filePath) =>
  new Promise((resolve, reject) => {
    const proc = spawn("truncate", ["-s", "0", filePath]);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`truncate exited with code ${code}`));
    });
  });

const renderGroupList = (c, state = {}) => {
  const user = c.get("currentUser");
  const groups = GroupModel.listAll();
  const noticeKey = state.notice || c.req.query("notice");
  const html = renderPage("pages/groups/list", {
    ...basePageData(user, { activeNav: "groups" }),
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
  if (!targetUser) return c.redirect("/users");
  const allGroups = GroupModel.listAll();
  const assigned = new Set(
    (state.assignedGroups || UserGroupModel.listGroupsForUser(targetUser.id)).map((g) => g.id),
  );
  const noticeKey = state.notice || c.req.query("notice");
  const html = renderPage("pages/users/groups", {
    ...basePageData(user, { activeNav: "users" }),
    pageTitle: "User groups",
    userName: targetUser.name,
    userEmail: targetUser.email,
    formAction: `/users/${targetUser.id}/groups`,
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
  }));
  const html = renderPage("pages/logs/list", {
    ...basePageData(user, { activeNav: "logs" }),
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
  const html = renderPage("pages/logs/form", {
    ...basePageData(user, { activeNav: "logs" }),
    pageTitle: state.title,
    title: state.title,
    formAction: state.formAction,
    submitLabel: state.submitLabel,
    nameValue: state.nameValue || "",
    descriptionValue: state.descriptionValue || "",
    filePathValue: state.filePathValue || "",
    tailLinesValue: state.tailLinesValue || DEFAULT_TAIL_LINES,
    allowClear: !!state.allowClear,
    groups,
    noGroupSelected: selectedGroupId === null,
    error: state.error,
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

router.get("/groups", requireSuperAdmin((c) => renderGroupList(c)));

router.get(
  "/groups/new",
  requireSuperAdmin((c) =>
    renderGroupForm(c, {
      title: "Create group",
      formAction: "/groups",
      submitLabel: "Create",
      showSlugField: true,
    }),
  ),
);

router.post(
  "/groups",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const slugInput = typeof body.slug === "string" ? body.slug : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const slug = normalizeSlug(slugInput);

    if (!name || !slug) {
      return renderGroupForm(c, {
        title: "Create group",
        formAction: "/groups",
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
        formAction: "/groups",
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
        formAction: "/groups",
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

    return c.redirect("/groups?notice=created");
  }),
);

router.get(
  "/groups/:id/edit",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const group = GroupModel.findById(id);
    if (!group) {
      return renderGroupList(c, { error: "Group not found." });
    }
    return renderGroupForm(c, {
      title: "Edit group",
      formAction: `/groups/${group.id}`,
      submitLabel: "Save changes",
      nameValue: group.name,
      slugValue: group.slug,
      descriptionValue: group.description,
      showSlugField: false,
    });
  }),
);

router.post(
  "/groups/:id",
  requireSuperAdmin(async (c) => {
    const id = Number(c.req.param("id"));
    const group = GroupModel.findById(id);
    if (!group) {
      return renderGroupList(c, { error: "Group not found." });
    }

    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";

    if (!name) {
      return renderGroupForm(c, {
        title: "Edit group",
        formAction: `/groups/${group.id}`,
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

    return c.redirect("/groups?notice=updated");
  }),
);

router.post(
  "/groups/:id/delete",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const group = GroupModel.findById(id);
    if (!group) {
      return renderGroupList(c, { error: "Group not found." });
    }
    GroupModel.remove(id);
    return c.redirect("/groups?notice=deleted");
  }),
);

router.get("/users", requireSuperAdmin((c) => renderUserList(c)));

router.get(
  "/users/new",
  requireSuperAdmin((c) =>
    renderUserForm(c, {
      title: "Create user",
      formAction: "/users",
      submitLabel: "Create",
    }),
  ),
);

router.post(
  "/users",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

    if (!name || !username || !email || !password) {
      return renderUserForm(c, {
        title: "Create user",
        formAction: "/users",
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
        formAction: "/users",
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
        formAction: "/users",
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
          formAction: "/users",
          submitLabel: "Create",
          nameValue: name,
          usernameValue: username,
          emailValue: email,
          error: "Username or email already exists.",
        });
      }
      throw error;
    }

    return c.redirect("/users?notice=created");
  }),
);

router.get(
  "/users/:id/edit",
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
      formAction: `/users/${target.id}`,
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
  "/users/:id",
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
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

    if (!name) {
      return renderUserForm(c, {
        title: "Edit user",
        formAction: `/users/${target.id}`,
        submitLabel: "Save changes",
        nameValue: name,
        usernameValue: target.username,
        emailValue: target.email,
        credentialsReadOnly: true,
        passwordOptional: true,
        error: "Name is required.",
      });
    }

    UserModel.updateProfile(target.id, { name });

    if (password || confirmPassword) {
      if (password.length < 6) {
        return renderUserForm(c, {
          title: "Edit user",
          formAction: `/users/${target.id}`,
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
          formAction: `/users/${target.id}`,
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

    return c.redirect("/users?notice=updated");
  }),
);

router.get(
  "/users/:id/groups",
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
  "/users/:id/groups",
  requireSuperAdmin(async (c) => {
    const id = Number(c.req.param("id"));
    const target = UserModel.findById(id);
    if (!target) return renderUserList(c, { error: "User not found." });
    if (target.role === USER_ROLES.SUPERADMIN) {
      return renderUserList(c, { error: "Superadmin already has access to all groups." });
    }

    const body = await c.req.parseBody();
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

    return c.redirect(`/users/${target.id}/groups?notice=groups`);
  }),
);

router.post(
  "/users/:id/delete",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const target = UserModel.findById(id);
    if (!target) {
      return renderUserList(c, { error: "User not found." });
    }
    if (target.role === USER_ROLES.SUPERADMIN) {
      return renderUserList(c, { error: "Superadmin can only be managed via CLI." });
    }
    UserModel.remove(target.id);
    return c.redirect("/users?notice=deleted");
  }),
);

router.get("/logs", requireSuperAdmin((c) => renderLogList(c)));

router.get(
  "/logs/new",
  requireSuperAdmin((c) =>
    renderLogForm(c, {
      title: "Register log",
      formAction: "/logs",
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

router.post(
  "/logs",
  requireSuperAdmin(async (c) => {
    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    const tailLines = parseTailLines(body.tailLines ?? DEFAULT_TAIL_LINES);
    const allowClear = allowClearFromBody(body.allowClear);
    const groupId = parseGroupId(body.groupId);

    if (!name || !filePath || tailLines === null) {
      return renderLogForm(c, {
        title: "Register log",
        formAction: "/logs",
        submitLabel: "Create log",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines || DEFAULT_TAIL_LINES,
        allowClear,
        groupId,
        error: "Name, file path, and a valid tail line count are required.",
      });
    }

    if (groupId !== null && !GroupModel.findById(groupId)) {
      return renderLogForm(c, {
        title: "Register log",
        formAction: "/logs",
        submitLabel: "Create log",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines,
        allowClear,
        groupId,
        error: "Selected group does not exist.",
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
      createdByUserId: currentUser?.id ?? null,
    });

    return c.redirect("/logs?notice=created");
  }),
);

router.get(
  "/logs/:id/edit",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const log = LogModel.findById(id);
    if (!log) {
      return renderLogList(c, { error: "Log entry not found." });
    }
    return renderLogForm(c, {
      title: "Edit log",
      formAction: `/logs/${log.id}`,
      submitLabel: "Save changes",
      nameValue: log.name,
      descriptionValue: log.description,
      filePathValue: log.filePath,
      tailLinesValue: log.tailLines,
      allowClear: !!log.allowClear,
      groupId: log.groupId,
    });
  }),
);

router.post(
  "/logs/:id",
  requireSuperAdmin(async (c) => {
    const id = Number(c.req.param("id"));
    const log = LogModel.findById(id);
    if (!log) {
      return renderLogList(c, { error: "Log entry not found." });
    }
    const body = await c.req.parseBody();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const filePath = typeof body.filePath === "string" ? body.filePath.trim() : "";
    const tailLines = parseTailLines(body.tailLines ?? log.tailLines);
    const allowClear = allowClearFromBody(body.allowClear);
    const groupId = parseGroupId(body.groupId);

    if (!name || !filePath || tailLines === null) {
      return renderLogForm(c, {
        title: "Edit log",
        formAction: `/logs/${log.id}`,
        submitLabel: "Save changes",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines || log.tailLines,
        allowClear,
        groupId,
        error: "Name, file path, and a valid tail line count are required.",
      });
    }
    if (groupId !== null && !GroupModel.findById(groupId)) {
      return renderLogForm(c, {
        title: "Edit log",
        formAction: `/logs/${log.id}`,
        submitLabel: "Save changes",
        nameValue: name,
        descriptionValue: description,
        filePathValue: filePath,
        tailLinesValue: tailLines,
        allowClear,
        groupId,
        error: "Selected group does not exist.",
      });
    }

    LogModel.update(log.id, {
      name,
      description,
      filePath,
      tailLines,
      allowClear,
      groupId,
    });

    return c.redirect("/logs?notice=updated");
  }),
);

router.post(
  "/logs/:id/delete",
  requireSuperAdmin((c) => {
    const id = Number(c.req.param("id"));
    const log = LogModel.findById(id);
    if (!log) {
      return renderLogList(c, { error: "Log entry not found." });
    }
    LogModel.remove(id);
    return c.redirect("/logs?notice=deleted");
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
      pageTitle: `${log.name} · Logs`,
      logId: log.id,
      name: log.name,
      description: log.description,
      groupLabel: log.groupName || "No group",
      groupDescription: log.groupDescription || "",
      filePath: log.filePath,
      tailLines: log.tailLines,
      allowClear: !!log.allowClear,
    });
    return c.html(html);
  }),
);

router.get(
  "/logs/:id/content",
  requireAuth(async (c) => {
    const { log, error } = getAuthorizedLog(c);
    if (error) return error;
    try {
      const text = await runTail(log.filePath, log.tailLines);
      return c.text(text, 200);
    } catch (err) {
      return c.text(`Failed to read log: ${err.message}`, 500);
    }
  }),
);

router.post(
  "/logs/:id/clear",
  requireAuth(async (c) => {
    const { log, error } = getAuthorizedLog(c);
    if (error) return error;
    if (!log.allowClear) {
      return c.text("Clearing disabled for this log.", 403);
    }
    try {
      await truncateFile(log.filePath);
      return c.text("Log cleared.");
    } catch (err) {
      return c.text(`Failed to clear log: ${err.message}`, 500);
    }
  }),
);

router.post(
  "/logout",
  requireAuth((c) => {
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
