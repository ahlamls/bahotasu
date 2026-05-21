                                                                    # Security Remediation Plan

Document owner: Agus / Bahotasu maintainers  
Created by: OpenAI Codex GPT-5, 2026-05-20, Asia/Jakarta  
Scope: Remediation plan for the whole Bahotasu operations dashboard after the security review on 2026-05-20.

## Current State

The review found one critical exposure path, three high-risk application or dependency issues, and three medium-risk hardening gaps.

Agus already ran `git rm --cached` for the tracked SQLite runtime files. In the current working tree that shows as staged deletes for:

- `data/bahotasu.sqlite`
- `data/bahotasu.sqlite-shm`
- `data/bahotasu.sqlite-wal`

This removes the runtime database files from future commits, but it does not remove old copies from git history and it does not rotate anything that may already be exposed.

## Security Goals

1. Prevent committed or locally readable runtime state from exposing account, session, SSH, command, or environment data.
2. Make environment file access explicitly privileged, not globally available by accident.
3. Bring production dependencies to a clean audited state.
4. Reduce account takeover risk through rate limiting, stronger password policy, and session invalidation.
5. Add baseline browser security headers and remove CDN supply-chain exposure where practical.
6. Make the fix verifiable through concrete local checks before deployment.

## Prioritization Rule

In this document, `low risk` means low risk of breaking the current application code path or user flow. It does not mean low security severity.

Security severity stays the first priority:

1. Fix critical and high security issues first.
2. Within those critical/high issues, start with changes that have the lowest breakage risk.
3. Defer medium hardening only when it is not needed to close the critical/high exploit path.
4. Do not ship a broad refactor as part of a security fix when a surgical patch closes the issue.

This gives the working order below:

| Order | Item | Security Severity | Breakage Risk | Why This Comes Here |
|---|---|---:|---:|---|
| 1 | Stop tracking SQLite runtime files | Critical | Low | Already done via `git rm --cached`; this changes repository tracking, not runtime behavior. |
| 2 | Rotate SSH/env/session secrets | Critical | Low-Medium | Operational action; can break remote access only if credentials are not re-entered correctly. |
| 3 | Restrict environment file access | High | Low | Small access-control change with clear expected behavior and direct verification. |
| 4 | Upgrade vulnerable Hono packages | High | Medium | Required for dependency vulnerabilities, but must smoke-test routing/static behavior. |
| 5 | Add auth/re-auth rate limiting | High | Medium | Security-critical, but needs careful thresholds so legitimate users are not locked out. |
| 6 | Track `package-lock.json` | High support item | Low | Makes dependency remediation reproducible; no runtime flow change. |
| 7 | Invalidate all sessions on password change | Medium | Low | Narrow session-model change; supports account takeover containment. |
| 8 | Add security headers / CDN decision | Medium | Medium | Headers are easy, but CSP/CDN choices can break inline scripts if done too aggressively. |

## Priority 0 - Immediate Containment

### P0.1 Keep SQLite runtime files out of git

Status: partially done by `git rm --cached`.

Actions:

1. Keep `.gitignore` entries for `.env`, `.env.*`, `data`, and `data/*`.
2. Commit the staged deletes for `data/bahotasu.sqlite`, `data/bahotasu.sqlite-shm`, and `data/bahotasu.sqlite-wal`.
3. Verify they are no longer tracked:

```bash
git ls-files data
```

Expected result: no SQLite runtime files are listed.

Confidence: 99%. Removing tracked runtime files prevents future commits from carrying live DB state.

### P0.2 Rotate exposed credentials and sessions

Reasoning chain:

1. The runtime DB contains encrypted SSH credential material.
2. The local `.env` contains `BAHOTASU_ENC_KEY`.
3. If both are readable by another local user, copied by a backup, or already pushed elsewhere, AES-GCM encryption no longer protects the SSH credential.
4. Therefore the correct response is rotation, not only removing the DB from git.

Actions:

1. Rotate the SSH key/password for any server stored in `servers`, especially the `pulshui` server found during review.
2. Generate a new `BAHOTASU_ENC_KEY`.
3. Re-enter remote server credentials through the admin UI so they are encrypted under the new key.
4. Delete all existing sessions from SQLite:

```sql
DELETE FROM sessions;
```

5. Force password changes for real users if this repository or machine has ever been shared.

Confidence: 95%. This is required if old DB files or `.env` might have left the machine.

### P0.3 Decide whether git history rewrite is required

Use this decision rule:

- If this repository has ever been pushed, forked, copied, backed up, or shared: rewrite history and treat exposed secrets as compromised.
- If this repository has only existed on this local machine and has never been shared: history rewrite is lower priority, but still useful hygiene.

Recommended commands should be chosen carefully because history rewrite affects collaborators. Use `git filter-repo` or BFG only after confirming the repository sharing status.

Confidence: 85%. The decision depends on repository distribution, which must be confirmed by the maintainer.

## Priority 1 - High-Risk Application Fixes

### P1.1 Restrict Environment Variables access

Problem:

`EnvironmentFileModel.canAccess()` currently allows regular authenticated users to access active environment registrations when `group_id` is `NULL`. For logs and commands, ungrouped means everyone. For environment files, that is unsafe because the editor reads plaintext secret values.

Files to update:

- `src/models/environmentFiles.js`
- `src/routes/web/index.js`
- `FRD.md`

Target behavior:

1. Superadmin can access all environment files.
2. Regular users can access only active environment files assigned to one of their groups.
3. Ungrouped environment files should be superadmin-only by default.
4. The admin UI should label ungrouped environment files as `Superadmin only`, not `Everyone`.
5. The dashboard should not show ungrouped environment files to regular users.

Secure code shape:

```js
canAccess(user, envFile) {
  if (!user || !envFile) return false;
  if (user.role === USER_ROLES.SUPERADMIN) return true;
  if (!envFile.isActive) return false;
  if (!envFile.groupId) return false;

  const row = db()
    .prepare("SELECT 1 FROM user_groups WHERE user_id = ? AND group_id = ?")
    .get(user.id, envFile.groupId);

  return !!row;
}
```

Verification:

1. Seed or use a regular user.
2. Create one active environment registration with no group.
3. Confirm the regular user cannot see it on `/dashboard`.
4. Confirm direct `GET /environments/:id/edit` returns 403 for the regular user.
5. Confirm superadmin can still edit it.

Confidence: 98%. The vulnerable access rule is explicit and easy to test.

### P1.2 Upgrade vulnerable Hono packages

Problem:

`npm audit --omit=dev` reported high severity vulnerabilities in direct production dependencies:

- `hono@4.10.6`
- `@hono/node-server@1.19.6`

Files to update:

- `package.json`
- `package-lock.json`

Target versions:

- `hono` to the latest compatible safe version, observed during review as `4.12.21`.
- `@hono/node-server` to a safe version above the advisory ranges. Prefer latest stable, but test for breaking changes if moving to `2.x`.

Verification:

```bash
npm install
npm audit --omit=dev
node -e "import('./src/app.js').then(() => console.log('app imports'))"
```

Then manually smoke test:

1. `GET /healthz`
2. `GET /static/logo.svg`
3. `GET /login`
4. Authenticated dashboard load
5. Log viewer content fetch
6. Command dashboard load
7. Environment editor load

Confidence: 90%. Audit confirms vulnerable versions; compatibility must be verified because package upgrades can change route/static behavior.

### P1.3 Add authentication rate limiting and strengthen passwords

Problem:

Login, command re-authentication, and environment save re-authentication perform password verification without throttling. Password minimum is currently 6 characters.

Files to update:

- `src/routes/web/index.js`
- `src/routes/web/commandRunner.js`
- `src/lib/password.js` or a new auth-limit helper if needed
- `FRD.md`

Target behavior:

1. `/login` limits failed attempts by IP and identifier.
2. Command execution re-auth limits failed attempts by user ID and command ID.
3. Environment save re-auth limits failed attempts by user ID and environment ID.
4. New passwords require at least 12 characters.
5. Error messages stay generic enough to avoid account enumeration.

Implementation guidance:

- Use a small in-memory limiter first, because the app is a low-volume single-process dashboard.
- If the app later runs multiple processes, move limiter state to SQLite.
- Keep rate-limit keys specific enough that one user cannot easily lock out every user.

Secure code shape:

```js
const authAttempts = new Map();

const checkRateLimit = (key, { limit = 5, windowMs = 15 * 60 * 1000 } = {}) => {
  const now = Date.now();
  const entry = authAttempts.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > entry.resetAt) {
    entry.count = 0;
    entry.resetAt = now + windowMs;
  }

  entry.count += 1;
  authAttempts.set(key, entry);

  return entry.count <= limit;
};
```

Verification:

1. Five wrong login attempts return normal invalid credential response.
2. Next wrong attempt returns 429.
3. Correct login still works after the window resets.
4. Command re-auth and env-save re-auth throttle independently.
5. Existing password hashes still verify.
6. New password creation/change rejects fewer than 12 characters.

Confidence: 92%. Missing throttling is clear; exact thresholds are policy choices.

## Priority 2 - Medium-Risk Hardening

### P2.1 Invalidate all sessions after password change

Problem:

The current password-change flow deletes only the current session. Other active sessions survive.

Files to update:

- `src/models/sessions.js`
- `src/routes/web/index.js`
- `FRD.md`

Target behavior:

After successful password change, delete every session for that user and clear the current browser cookie.

Secure code shape:

```js
deleteByUserId(userId) {
  db().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}
```

Verification:

1. Log in from two browsers.
2. Change password in browser A.
3. Browser A is redirected to login.
4. Browser B is no longer authenticated on refresh.

Confidence: 99%. Current code deletes only one session by ID.

### P2.2 Add security headers and remove CDN dependency where possible

Problem:

The app does not currently set baseline browser security headers. Bootstrap CSS/JS loads from jsDelivr without SRI or CSP.

Files to update:

- `src/app.js`
- `src/views/layouts/base.mustache`
- Possibly `resources/` if Bootstrap is self-hosted
- `FRD.md`

Target behavior:

1. Set `X-Frame-Options: DENY`.
2. Set `X-Content-Type-Options: nosniff`.
3. Set `Referrer-Policy: same-origin`.
4. Set a narrow `Permissions-Policy`.
5. Set HSTS in production.
6. Prefer self-hosted Bootstrap assets, or add SRI and CSP allowances for jsDelivr.

Secure code shape:

```js
app.use("*", async (c, next) => {
  c.header("X-Frame-Options", "DENY");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (process.env.NODE_ENV === "production") {
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }

  await next();
});
```

Verification:

```bash
curl -I http://localhost:4000/login
```

Check the expected headers are present.

Confidence: 95%. Headers are absent today; the exact CSP depends on whether Bootstrap remains CDN-hosted.

### P2.3 Track `package-lock.json`

Problem:

`.gitignore` ignores `package-lock.json`, so dependency state is not reproducible.

Files to update:

- `.gitignore`
- `package-lock.json`

Target behavior:

1. Remove `package-lock.json` from `.gitignore`.
2. Commit `package-lock.json`.
3. Use `npm ci` in deployment.

Verification:

```bash
git status --short package-lock.json
npm ci
npm audit --omit=dev
```

Confidence: 95%. Reproducible dependency state is standard Node security practice.

## Priority 3 - Follow-Up Hardening

### P3.1 Review command runner privilege model

Current model intentionally allows superadmins to define shell commands and group users to execute them. This is powerful by design, not automatically a vulnerability.

Recommended improvements:

1. Make `password_required = true` the default for new commands.
2. Add a visual high-risk label for commands that run against remote servers.
3. Consider requiring superadmin approval for command edits that change the command string.
4. Consider command-output redaction for obvious secret patterns before storing output.

Confidence: 80%. These are defense-in-depth improvements; exact need depends on team workflow.

### P3.2 Reduce stored environment secret exposure in the browser

Current editor loads plaintext env values into browser JavaScript for editing. That is necessary for a full editor, but it increases exposure if a browser extension, XSS, or shared workstation is compromised.

Options:

1. Keep current full editor, but require stricter access and CSP.
2. Mask secret-like values by default and reveal on click.
3. Support key-by-key editing without sending every value to the browser.

Recommended path:

Start with option 1 in P1/P2, then evaluate option 2 if the editor is used for real production secrets.

Confidence: 75%. This is a product/security tradeoff, not a single obvious code bug.

## Implementation Order

Use this order because it prioritizes critical/high security impact while still minimizing breakage risk:

1. Commit the SQLite untracking change.
   - Security severity: Critical.
   - Breakage risk: Low.
   - Verification: `git ls-files data` returns nothing.

2. Rotate credentials, delete sessions, and set strict file permissions.
   - Security severity: Critical.
   - Breakage risk: Low-Medium.
   - Verification: affected server connections are re-tested through the UI, and existing sessions no longer authenticate.

3. Patch environment access control and update FRD.
   - Security severity: High.
   - Breakage risk: Low.
   - Verification: regular users cannot access ungrouped env files; superadmins still can.

4. Upgrade vulnerable Hono packages and commit `package-lock.json`.
   - Security severity: High.
   - Breakage risk: Medium.
   - Verification: `npm audit --omit=dev` plus smoke tests for `/healthz`, `/static/logo.svg`, `/login`, dashboard, logs, commands, and environment editor.

5. Add auth/re-auth rate limiting and 12-character password policy.
   - Security severity: High.
   - Breakage risk: Medium.
   - Verification: brute-force attempts get 429 while normal login/re-auth still works.

6. Invalidate all sessions on password change.
   - Security severity: Medium.
   - Breakage risk: Low.
   - Verification: password change logs out every active browser session for that user.

7. Add baseline security headers first, then decide CDN vs self-hosted Bootstrap/CSP.
   - Security severity: Medium.
   - Breakage risk: Low for basic headers, Medium for strict CSP.
   - Verification: headers are present and inline scripts still run where intentionally allowed.

8. Run the full verification checklist.

## Verification Checklist

Run after implementation:

```bash
git ls-files data
git status --short .env data package-lock.json
npm audit --omit=dev
node -e "import('./src/app.js').then(() => console.log('app imports'))"
```

Manual browser checks:

- Superadmin login works.
- Regular user login works.
- Regular user cannot access ungrouped environment file by dashboard or direct URL.
- Superadmin can access ungrouped environment file.
- Password change logs out all active sessions.
- Login throttling returns 429 after the configured limit.
- Command re-auth throttling works.
- Environment save re-auth throttling works.
- `/static/logo.svg` still loads after dependency upgrades.
- Security headers are present on `/login` and authenticated pages.

## Stop Condition

The remediation is complete when:

1. No runtime DB or secret files are tracked.
2. Rotated credentials are confirmed.
3. `npm audit --omit=dev` is clean or every remaining advisory is documented as unreachable.
4. Regular users cannot read ungrouped environment files.
5. Authentication throttling and all-session invalidation are verified.
6. Security headers are visible in HTTP responses.
7. `FRD.md` reflects the new environment-access, password, session, and dependency-management rules.
