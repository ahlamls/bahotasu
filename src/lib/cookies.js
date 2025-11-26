export const parseCookies = (cookieHeader = "") => {
  const cookies = {};
  cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .forEach((part) => {
      const eqIndex = part.indexOf("=");
      if (eqIndex === -1) return;
      const name = part.slice(0, eqIndex).trim();
      const value = part.slice(eqIndex + 1).trim();
      if (!name) return;
      cookies[name] = decodeURIComponent(value || "");
    });
  return cookies;
};

const serializePair = (name, value) => `${name}=${encodeURIComponent(value)}`;

export const serializeCookie = (name, value, options = {}) => {
  if (!name) throw new TypeError("Cookie name is required");
  const segments = [serializePair(name, value ?? "")];

  if (options.maxAge !== undefined) {
    segments.push(`Max-Age=${Math.floor(options.maxAge)}`);
  }
  if (options.expires) {
    segments.push(`Expires=${options.expires.toUTCString()}`);
  }
  segments.push(`Path=${options.path || "/"}`);
  if (options.domain) {
    segments.push(`Domain=${options.domain}`);
  }
  if (options.secure) {
    segments.push("Secure");
  }
  if (options.httpOnly !== false) {
    segments.push("HttpOnly");
  }
  const sameSite = options.sameSite || "Lax";
  if (sameSite) {
    segments.push(`SameSite=${sameSite}`);
  }

  return segments.join("; ");
};

