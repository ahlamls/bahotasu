import crypto from "node:crypto";
import { parseCookies, serializeCookie } from "../lib/cookies.js";
import { SessionModel } from "../models/index.js";
import { appConfig } from "../config/env.js";

export const SESSION_COOKIE = "bahotasu_session";
export const REMEMBER_COOKIE = "remember_me";
export const CSRF_COOKIE = "bahotasu_csrf";

const sessionCookieOptions = {
  path: "/",
  sameSite: "Lax",
  httpOnly: true,
  secure: appConfig.nodeEnv === "production",
};

const csrfCookieOptions = {
  path: "/",
  sameSite: "Lax",
  httpOnly: false,
  secure: appConfig.nodeEnv === "production",
  maxAge: 60 * 60 * 24 * 365,
};

const SESSION_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
let lastSessionCleanupAt = 0;

const maybeCleanupExpiredSessions = () => {
  const now = Date.now();
  if (now - lastSessionCleanupAt < SESSION_CLEANUP_INTERVAL_MS) return;
  lastSessionCleanupAt = now;
  try {
    SessionModel.deleteExpired();
  } catch (error) {
    console.warn("[session] Failed to cleanup expired sessions", error);
  }
};

export const attachSession = async (c, next) => {
  maybeCleanupExpiredSessions();

  const cookies = parseCookies(c.req.header("cookie"));
  let csrfToken = cookies[CSRF_COOKIE];
  if (!csrfToken) {
    csrfToken = crypto.randomBytes(32).toString("hex");
    c.header(
      "Set-Cookie",
      serializeCookie(CSRF_COOKIE, csrfToken, csrfCookieOptions),
      { append: true },
    );
  }
  c.set("csrfToken", csrfToken);

  const token = cookies[SESSION_COOKIE];

  if (token) {
    const session = SessionModel.findActiveByToken(token);
    if (session) {
      c.set("session", session);
      c.set("currentUser", session.user);
      SessionModel.touch(session.id);
    } else {
      c.header(
        "Set-Cookie",
        serializeCookie(SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 }),
        { append: true },
      );
    }
  }

  await next();
};

export const setSessionCookie = (c, token, maxAge) => {
  c.header(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, token, {
      ...sessionCookieOptions,
      maxAge,
    }),
    { append: true },
  );
};

export const clearSessionCookie = (c) => {
  c.header(
    "Set-Cookie",
    serializeCookie(SESSION_COOKIE, "", { ...sessionCookieOptions, maxAge: 0 }),
    { append: true },
  );
};

export const setRememberCookie = (c, remember) => {
  c.header(
    "Set-Cookie",
    serializeCookie(REMEMBER_COOKIE, remember ? "true" : "false", {
      path: "/",
      sameSite: "Lax",
      httpOnly: true,
      secure: appConfig.nodeEnv === "production",
      maxAge: 60 * 60 * 24 * 365,
    }),
    { append: true },
  );
};
