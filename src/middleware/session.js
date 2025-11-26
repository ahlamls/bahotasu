import { parseCookies, serializeCookie } from "../lib/cookies.js";
import { SessionModel } from "../models/index.js";
import { appConfig } from "../config/env.js";

export const SESSION_COOKIE = "bahotasu_session";
export const REMEMBER_COOKIE = "remember_me";

const sessionCookieOptions = {
  path: "/",
  sameSite: "Lax",
  httpOnly: true,
  secure: appConfig.nodeEnv === "production",
};

export const attachSession = async (c, next) => {
  const cookies = parseCookies(c.req.header("cookie"));
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
