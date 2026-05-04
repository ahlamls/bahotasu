# Functional Requirements Document (FRD)
## Bahotasu — Log Monitoring Tool

| Field | Value |
|---|---|
| **Project Name** | Bahotasu |
| **Version** | 1.0.0 |
| **Document Status** | Draft |
| **Author** | Agus |
| **Last Updated** | 2026-05-04 |

---

## Table of Contents

1. [Overview](#1-overview)
2. [Goals & Non-Goals](#2-goals--non-goals)
3. [User Roles & Permissions](#3-user-roles--permissions)
4. [System Architecture](#4-system-architecture)
5. [Functional Requirements](#5-functional-requirements)
   - 5.1 Authentication
   - 5.2 User Management
   - 5.3 Group Management
   - 5.4 Log Management
   - 5.5 Log Viewer
   - 5.6 Profile Management
   - 5.7 Command Runner
6. [Data Models](#6-data-models)
7. [Routes Reference](#7-routes-reference)
8. [Non-Functional Requirements](#8-non-functional-requirements)
9. [Constraints & Assumptions](#9-constraints--assumptions)
10. [Glossary](#10-glossary)

---

## 1. Overview

**Bahotasu** is a lightweight, role-aware, server-rendered operations dashboard built for development teams. It allows developers to inspect live application logs directly from a browser without needing SSH access, and to trigger pre‑approved shell commands on local or remote servers — all served through a fast, no-SPA interface backed by SQLite.

The system supports multiple projects ("groups"), multi-user access with role-based visibility, log interactions (tail viewing, full-file search, optional clearing), and a secure **Command Runner** module for asynchronous command execution with encrypted SSH credentials, re‑authentication gating, and an in‑process worker queue.

---

## 2. Goals & Non-Goals

### Goals

- Provide a web UI for developers to view server-side log files in real time.
- Enforce role-based access so users only see logs relevant to their assigned project group.
- Give a superadmin a CRUD interface to manage users, groups, and registered log files.
- Provide a secure command runner for triggering pre‑approved shell commands on local or remote servers.
- Avoid SPA complexity — all pages are server-rendered (Mustache) for performance and simplicity.
- Support multiple projects simultaneously by grouping log entries.

### Non-Goals

- This is **not** a log aggregation or parsing platform (no Elasticsearch, no structured querying).
- This is **not** a real-time streaming log service (no WebSocket tail).
- This does **not** ingest logs — it reads log files from the filesystem directly.
- This does **not** support multi-tenancy with data isolation between separate organizations.
- Alerting, notifications, or log-based metrics are out of scope.
- Real‑time command output streaming is out of scope; output is captured and returned in full after completion.
- Scheduled or recurring command execution is out of scope.
- Arbitrary user‑supplied arguments to commands are out of scope.

---

## 3. User Roles & Permissions

There are two roles in the system: **Superadmin** and **User**.

| Capability | Superadmin | User |
|---|---|---|
| Login / Logout | ✅ | ✅ |
| View own profile | ✅ | ✅ |
| Change own display name | ✅ | ✅ |
| Change own password | ✅ | ✅ |
| View dashboard (log cards) | ✅ | ✅ |
| View logs assigned to their groups | ✅ | ✅ |
| View **all** logs regardless of group | ✅ | ❌ |
| View ungrouped logs | ✅ | ✅ |
| Clear a log file (if enabled) | ✅ | ✅ |
| Search within a log file | ✅ | ✅ |
| Create / Edit / Delete groups | ✅ | ❌ |
| Create / Edit / Delete users | ✅ | ❌ |
| Assign users to groups | ✅ | ❌ |
| Create / Edit / Delete log entries | ✅ | ❌ |
| Access navigation (Groups, Users, Logs Mgmt) | ✅ | ❌ |
| Execute commands from Command Runner | ✅ | ✅ |
| View own execution history | ✅ | ✅ |
| View all execution history | ✅ | ❌ |
| Manage servers (CRUD + test connection) | ✅ | ❌ |
| Manage commands (CRUD) | ✅ | ❌ |
| Be created or edited via the UI | ❌ | ✅ |
| Be created via the CLI seeder | ✅ | ❌ |

**Key constraint:** Superadmin accounts are seeded exclusively via the CLI (`npm run seed:superadmin`). They cannot be created, edited, or deleted from the web UI.

---

## 4. System Architecture

```
┌─────────────────────────────────────────────────┐
│                   Browser (Client)               │
│         Bootstrap 5 + Mustache-rendered HTML     │
└───────────────────┬─────────────────────────────┘
                    │ HTTP
┌───────────────────▼─────────────────────────────┐
│              Hono Web Server (Node.js)           │
│  ┌──────────────────────────────────────────┐   │
│  │   Web Routes (/src/routes/web/)          │   │
│  │   + Command Runner Routes                │   │
│  │   Session Middleware (cookie-based)      │   │
│  │   Mustache View Engine                   │   │
│  └────────────────────┬─────────────────────┘   │
│                       │                         │
│  ┌────────────────────▼─────────────────────┐   │
│  │  Models (Users, Groups, Logs, Sessions,  │   │
│  │  UserGroups, Servers, Commands,          │   │
│  │  CommandExecutions)                      │   │
│  └────────────────────┬─────────────────────┘   │
│                       │                         │
│  ┌────────────────────▼─────────────────────┐   │
│  │        SQLite (better-sqlite3)           │   │
│  │        ./data/bahotasu.sqlite            │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Log I/O (tail, grep, sed, truncate      │   │
│  │  via Node child_process)                 │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Command Worker (setInterval 1s)         │   │
│  │  - Local execution (child_process.spawn) │   │
│  │  - Remote SSH (ssh2)                     │   │
│  │  - Credential decryption (AES-256-GCM)   │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

**Runtime:** Node.js ≥ 18.17  
**Framework:** Hono (`@hono/node-server`)  
**Database:** SQLite via `better-sqlite3`, auto-migrated on startup  
**Views:** Mustache templates + Bootstrap 5  
**Log I/O:** Native Unix commands (`tail`, `grep`, `sed`, `truncate`) via `child_process.spawn`  
**Command Execution:** `child_process.spawn` (local) or `ssh2` npm package (remote SSH)  
**Encryption:** AES‑256‑GCM via Node.js `crypto` for SSH credentials at rest  
**Worker:** In‑process `setInterval` polling `command_executions` table every 1 second  

---

## 5. Functional Requirements

---

### 5.1 Authentication

#### FR-AUTH-01 — Login

- The system provides a login page at `GET /login`.
- Users authenticate using either their **username** or **email**, plus a **password**.
- Credentials are validated against the database. Passwords are hashed using **scrypt**.
- If credentials are invalid or the account is inactive, a generic error message is shown ("Invalid credentials."). The system does not distinguish between wrong username and wrong password.
- On successful login, a session token is generated, stored in the `sessions` table, and written as an HTTP cookie.
- The login form includes a **"Remember me"** checkbox:
  - Checked: session cookie persists for **30 days**.
  - Unchecked: session cookie expires after **24 hours**.
- CSRF protection is enforced on all POST requests via a token embedded in forms.

#### FR-AUTH-02 — Logout

- `POST /logout` invalidates the current session record in the database and clears the session cookie.
- The user is redirected to `/login`.

#### FR-AUTH-03 — Session Persistence

- The session middleware (`/src/middleware/session.js`) attaches `currentUser` to every request context by resolving the session cookie.
- Unauthenticated requests to protected routes are redirected to `/login`.
- Authenticated requests to `/login` are redirected to `/dashboard`.

---

### 5.2 User Management

> All User Management routes require the **Superadmin** role.

#### FR-USER-01 — List Users

- `GET /users` displays a paginated list of all users in the system.
- Each user row shows name, username, email, role, and active status.
- Users with the `superadmin` role are displayed but their **Edit** and **Delete** actions are suppressed with an indicator that they are managed via CLI.

#### FR-USER-02 — Create User

- `GET /users/new` renders the create user form.
- `POST /users` processes creation.
- Required fields: **name**, **username**, **email**, **password**, **confirm password**.
- Validations:
  - All fields are required.
  - Password must be at least **6 characters**.
  - Password and confirm password must match.
  - Username and email must be unique (enforced by DB UNIQUE constraint).
- On success, the user is created with `role = 'user'` and `is_active = 1`.
- Username and email are **immutable** after creation and cannot be changed via the UI.

#### FR-USER-03 — Edit User

- `GET /users/:id/edit` renders the edit form.
- `POST /users/:id` processes the update.
- Editable fields: **name**, **password** (optional).
- Username and email fields are rendered read-only.
- If a new password is provided, it must be at least 6 characters and match the confirmation.
- Attempting to edit a `superadmin` user returns an error.

#### FR-USER-04 — Delete User

- `POST /users/:id/delete` removes the user record.
- Cascade deletes apply to `user_groups` (group assignments) and `sessions`.
- Superadmin accounts cannot be deleted via the UI.

#### FR-USER-05 — Assign User to Groups

- `GET /users/:id/groups` displays a group assignment screen for the target user.
- All existing groups are listed with checkboxes indicating current assignments.
- `POST /users/:id/groups` accepts a list of selected group IDs and performs a diff-based sync: it adds new assignments and removes de-selected ones.
- Superadmin accounts cannot be group-assigned (they have access to everything by default).

#### FR-USER-06 — Deactivate User

- The `UserModel.deactivate(id)` function sets `is_active = 0`.
- Deactivated users cannot log in; their credentials are rejected with a generic error.
- Note: The UI currently exposes hard-delete only; deactivation is a model-level capability available for future use.

---

### 5.3 Group Management

> All Group Management routes require the **Superadmin** role.

#### FR-GROUP-01 — List Groups

- `GET /groups` displays all groups ordered by name.
- Each row shows the group name, slug, and description.

#### FR-GROUP-02 — Create Group

- `GET /groups/new` renders the create form.
- `POST /groups` processes creation.
- Required fields: **name**, **slug**.
- Optional field: **description**.
- The slug is auto-lowercased and must match `^[A-Za-z0-9_]+$`.
- Slug must be unique (enforced by DB constraint).
- The slug is **set at creation and cannot be modified later**.

#### FR-GROUP-03 — Edit Group

- `GET /groups/:id/edit` renders the edit form with the slug field hidden (read-only).
- `POST /groups/:id` updates **name** and **description** only. Slug is immutable.

#### FR-GROUP-04 — Delete Group

- `POST /groups/:id/delete` removes the group.
- Cascade deletes apply to `user_groups` (membership records).
- Logs with this `group_id` will have their `group_id` set to `NULL` (nullable FK, see migration 003).

---

### 5.4 Log Management

> All Log Management CRUD routes require the **Superadmin** role.  
> Viewing (read) routes are accessible to all authenticated users with appropriate group access.

#### FR-LOG-01 — List Logs (Admin)

- `GET /logs` displays all registered log entries.
- Each row shows: log name, description, file path, tail lines, group name, and allow-clear flag.

#### FR-LOG-02 — Register a Log

- `GET /logs/new` renders the creation form.
- `POST /logs` processes registration.
- Required fields: **name**, **file path**, **tail lines**.
- Optional fields: **description**, **group** (dropdown), **allow clear** (checkbox).
- Validations:
  - Name and file path are required.
  - Tail lines must be a finite integer in the range **10–10,000**. Default is `1000`.
  - If a group is selected, it must exist in the database.
- The log entry does not validate whether the file path actually exists at creation time; the viewer handles missing file errors at read time.
- `created_by_user_id` is stored as the creating superadmin's ID.

#### FR-LOG-03 — Edit Log

- `GET /logs/:id/edit` renders the edit form pre-populated with existing values.
- `POST /logs/:id` updates: name, description, file path, tail lines, allow clear, group.
- Group can be changed or cleared (set to no group / ungrouped).

#### FR-LOG-04 — Delete Log

- `POST /logs/:id/delete` removes the log registration record.
- This does **not** delete the actual log file from the filesystem.

---

### 5.5 Log Viewer

> Accessible to all authenticated users. Access is gated by group membership.

#### FR-VIEWER-01 — Access Control

- A user can view a log if any of the following are true:
  1. The user is a **superadmin**.
  2. The log has **no group** assigned (ungrouped logs are public to all authenticated users).
  3. The log's group is in the user's **assigned groups**.
- Unauthorized access returns HTTP 403.

#### FR-VIEWER-02 — Dashboard

- `GET /dashboard` displays log cards organized by group.
- Superadmins see all logs.
- Regular users see only logs accessible to them (their groups + ungrouped).
- Groups are sorted alphabetically. Ungrouped logs appear at the end under "Other logs."
- Each card links to the log viewer (`/logs/:id/view`).

#### FR-VIEWER-03 — Log View Page

- `GET /logs/:id/view` renders the viewer page.
- Displays: log name, description, group label, file path, tail line count.
- The actual log content is **not** embedded in the page; it is loaded asynchronously.

#### FR-VIEWER-04 — Log Content Fetch

- `GET /logs/:id/content` streams the tail of the log file as plain text.
- Uses the Unix `tail -n <tailLines> <filePath>` command via `child_process.spawn`.
- Returns HTTP 500 with an error message if the file cannot be read.
- This endpoint is called by the viewer page's JavaScript to populate the textarea.

#### FR-VIEWER-05 — Auto-Refresh

- The viewer page supports an **auto-refresh** toggle.
- When enabled, the log content is re-fetched periodically.
- The auto-refresh state persists across page reloads via `localStorage`.

#### FR-VIEWER-06 — Auto-Scroll

- The viewer page supports an **auto-scroll** toggle.
- When enabled, the textarea scrolls to the bottom after each content refresh.
- The auto-scroll state persists via `localStorage`.

#### FR-VIEWER-07 — Log Search

- `GET /logs/:id/search` renders the search interface.
- Accepts query parameter `?q=<string>`.
- Uses `grep -F -n` to perform a plain-text (non-regex) search across the full log file.
- Returns the **last 5 occurrences** of the search string.
- Each result includes **±10 lines of context** around the match.
- Results display line numbers, with the matching line marked with `>`.
- Maximum query length: **500 characters**.
- Returns a notice if no matches are found.

#### FR-VIEWER-08 — Log Clear

- `POST /logs/:id/clear` truncates the log file to zero bytes.
- Only available if the log entry has `allow_clear = 1`.
- CSRF protection is enforced.
- Uses `truncate -s 0 <filePath>` via `child_process.spawn`.
- Returns HTTP 403 if clearing is disabled for that log.
- The **Clear** button on the viewer page is only rendered when `allow_clear` is true.

---

### 5.6 Profile Management

> Available to all authenticated users.

#### FR-PROFILE-01 — View Profile

- `GET /profile` displays the current user's profile information.
- Shows: username (read-only), email (read-only), display name, role, and group memberships.

#### FR-PROFILE-02 — Update Display Name

- `POST /profile/name` updates the user's `name` field.
- Required: non-empty display name.
- The session's in-memory user object is updated immediately so the header reflects the change without re-login.

#### FR-PROFILE-03 — Change Password

- `POST /profile/password` updates the user's password.
- Required fields: current password, new password, confirm new password.
- Validations:
  - All fields are required.
  - Current password must be verified against the stored hash.
  - New password must be at least **6 characters**.
  - New password and confirmation must match.
- On success, the **current session is invalidated** and the user is redirected to `/login?notice=password-updated`, forcing a re-login with the new credentials.

---

### 5.7 Command Runner

> All Server and Command CRUD routes require the **Superadmin** role.  
> Command execution and history viewing are accessible to all authenticated users with group-based access control.

#### FR-ENC-01 — Encryption Key Auto-Generation

- On startup, if `BAHOTASU_ENC_KEY` is not set in the environment, the server generates a 32-byte random hex string and appends it to the `.env` file.
- If `.env` is not writable, the server exits with an error.
- The key is loaded into memory as a `Buffer` and used for AES-256-GCM encrypt/decrypt operations on SSH credentials.
- Only SSH credentials in the `servers` table are encrypted/decrypted.

#### FR-SRV-01 — Seed "This Server"

- Migration 005 inserts a server record representing the local machine: `host = NULL`, `auth_type = 'local'`, `name = 'This Server'`.
- This record cannot be deleted via the UI (delete button is hidden).
- All routes for this record skip the host/port/credential UI fields.

#### FR-SRV-02 — List Servers

- `GET /admin/servers` displays all servers with name, host label ("Local" or IP), port, auth type, and actions.
- Includes a "Test" button per row for connection testing.

#### FR-SRV-03 — Create Server

- `GET /admin/servers/new` renders the create form.
- `POST /admin/servers` processes creation.
- Required: **name**, **host** (unless local), **auth type** (`local`, `key`, or `password`), and **credential** (for `key`/`password`).
- Credential is encrypted via AES-256-GCM before insert.
- Port defaults to 22 for remote servers.

#### FR-SRV-04 — Edit Server

- `GET /admin/servers/:id/edit` renders the edit form pre-populated.
- `POST /admin/servers/:id` updates name, host, port, credential.
- If a new credential is provided, it replaces the old one after re-encryption. If left blank, the existing credential is preserved.
- "This Server" fields (host, port, auth type) are read-only.

#### FR-SRV-05 — Delete Server

- `POST /admin/servers/:id/delete` removes the server record.
- Commands referencing this server get their `server_id` set to `NULL` (ON DELETE SET NULL).
- "This Server" is undeletable.

#### FR-SRV-06 — Test Connection

- `POST /admin/servers/:id/test` attempts `echo OK` on the target (local spawn or SSH exec).
- Returns JSON `{ success: true/false, message: "..." }`.
- Credentials are decrypted in-memory only during the test, never exposed in the response.

#### FR-CMD-01 — List Commands

- `GET /admin/commands` displays all commands with name, server, group, active status, and command string.
- Each row has Edit and Delete actions.

#### FR-CMD-02 — Create Command

- `GET /admin/commands/new` renders the create form.
- `POST /admin/commands` processes creation.
- Required: **name**, **command string**, **server** (dropdown).
- Optional: **description**, **group** (dropdown), **password required** (checkbox), **active** (checkbox, default true).
- The command string is a fixed shell command; no user input is ever interpolated.
- `created_by_user_id` is stored as the creating superadmin's ID.

#### FR-CMD-03 — Edit Command

- `GET /admin/commands/:id/edit` renders the edit form pre-populated.
- `POST /admin/commands/:id` updates all fields.
- Does not affect queued or currently running executions.

#### FR-CMD-04 — Delete Command

- `POST /admin/commands/:id/delete` removes the command.
- Associated execution history rows keep their `command_id` as `NULL` (ON DELETE SET NULL), with `command_name` denormalised for display.

#### FR-CMD-05 — Toggle Active

- The `is_active` field can be set via the edit form. Disabled commands show a "Disabled" badge on the dashboard and cannot be executed.

#### FR-QUE-01 — Queue Table

- The `command_executions` table stores execution requests with status: `pending`, `running`, `completed`, `failed`.
- Every execution creates a permanent audit record.

#### FR-QUE-02 — Worker

- The worker starts with the HTTP server using `setInterval` (1-second poll interval).
- Picks the oldest `pending` row and processes it.
- Status transitions: `pending` → `running` → `completed` (or `failed`).
- Processes one execution at a time (single-threaded, lock-guarded).

#### FR-QUE-03 — Local Execution

- The command string is executed via `/bin/sh -c <command>` using `child_process.spawn`.
- stdout and stderr are captured and combined.
- Output is truncated to 100 KB with a notice appended.

#### FR-QUE-04 — Remote SSH Execution

- SSH connections are made via the `ssh2` npm package.
- Private key or password is decrypted from `servers` table at runtime using the encryption key.
- The command is executed, output captured and truncated to 100 KB.

#### FR-QUE-05 — Timeout

- Commands that run longer than `COMMAND_TIMEOUT_SEC` (default 30s) are killed via `SIGTERM` (then `SIGKILL` after 2s) and marked as `failed`.
- Configurable via environment variable.

#### FR-EXEC-01 — Command Dashboard

- `GET /commands` displays command cards grouped by project group (same pattern as log dashboard).
- Superadmins see all commands; regular users see commands in their assigned groups + ungrouped commands.
- Each card shows: command name, description, target server badge, password-required badge, active/disabled badge.
- Each active card has an **Execute** button that opens a Bootstrap confirmation modal.

#### FR-EXEC-02 — Access Control

- A user can execute a command if:
  1. The user is a **superadmin**, OR
  2. The command has **no group** assigned (ungrouped commands are public to all authenticated users), OR
  3. The command's group is in the user's **assigned groups**.
- The command must also be active (`is_active = 1`).
- Unauthorized access returns HTTP 403 (JSON).

#### FR-EXEC-03 — Confirmation Modal

- Displays the command name, a warning message, and the target server.
- If `password_required = true`, includes a password input field.
- Has "Confirm & Execute" and "Cancel" buttons.

#### FR-EXEC-04 — Re-Authentication

- If `password_required = true`, the provided password is verified against the user's scrypt hash using timing-safe comparison.
- Failure blocks execution and returns an error message in the modal.

#### FR-EXEC-05 — Queue Submission

- `POST /commands/:id/execute` validates CSRF token, command existence, active status, group access, and optional password.
- Inserts a row into `command_executions` with status `pending`, user ID, command ID, denormalised `server_id` and `command_name`.
- Returns JSON `{ execution_id: <id>, status: "queued" }`.

#### FR-EXEC-06 — Polling for Result

- The client polls `GET /commands/:id/executions/:execution_id` every 2 seconds.
- Response includes `status`, `output` (if completed), `exit_code`, `error_summary`, `started_at`, `completed_at`.
- Access restricted: only the owning user or a superadmin can view the execution record.
- On completion, the modal shows a success/failure message and the output in a scrollable `<pre>` block.
- On failure, the error summary is displayed.

#### FR-AUD-01 — Execution History

- `GET /commands/:id/history` shows the user's own past executions (or all for superadmin) for a specific command.
- `GET /commands/history` shows all executions. Superadmins can filter by command and status.
- Each row shows: execution ID (linked to the execution viewer page), command name, user who triggered it, status badge, start time, completion time, exit code. The User column is visible to all users (regular users see their own name; superadmins see the executor's name).
- Every execution record has a unique auto-increment ID that serves as a permanent reference identifier. This ID is displayed on the history table as `#ID` (clickable link to the execution viewer) and in the execution viewer page header.
- Records are ordered by creation time (newest first), limited to 200 rows.

---

## 6. Data Models

### Users

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `username` | TEXT UNIQUE | Set at creation, immutable |
| `email` | TEXT UNIQUE | Set at creation, immutable |
| `name` | TEXT | Display name, editable |
| `password_hash` | TEXT | scrypt hash |
| `role` | TEXT | `'user'` or `'superadmin'` |
| `is_active` | INTEGER | 1 = active, 0 = deactivated |
| `last_login_at` | TEXT | ISO 8601 timestamp |
| `created_at` | TEXT | ISO 8601 timestamp |
| `updated_at` | TEXT | ISO 8601 timestamp |

### Groups

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `slug` | TEXT UNIQUE | Alphanumeric + underscore, immutable |
| `name` | TEXT | Display name |
| `description` | TEXT | Optional |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

### Logs

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `group_id` | INTEGER FK | Nullable; references `groups.id` |
| `name` | TEXT | Friendly display name |
| `description` | TEXT | Optional |
| `file_path` | TEXT | Absolute or relative path to log file on server |
| `tail_lines` | INTEGER | Range: 10–10,000; default 500 |
| `allow_clear` | INTEGER | 0 = disabled, 1 = enabled |
| `created_by_user_id` | INTEGER FK | Nullable; references `users.id` |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

### UserGroups

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `user_id` | INTEGER FK | References `users.id` ON DELETE CASCADE |
| `group_id` | INTEGER FK | References `groups.id` ON DELETE CASCADE |
| `created_at` | TEXT | Assignment timestamp |

Unique constraint on `(user_id, group_id)`.

### Sessions

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | Auto-increment |
| `user_id` | INTEGER FK | References `users.id` |
| `token` | TEXT UNIQUE | Securely random string |
| `remember` | INTEGER | 0 or 1 |
| `created_at` | TEXT | |
| `expires_at` | TEXT | |

### Servers (Command Runner)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `name` | TEXT NOT NULL | |
| `host` | TEXT | NULL for local |
| `port` | INTEGER DEFAULT 22 | |
| `auth_type` | TEXT NOT NULL | `'key'`, `'password'`, or `'local'` |
| `encrypted_private_key` | TEXT | AES-256-GCM encrypted PEM |
| `encrypted_password` | TEXT | AES-256-GCM encrypted password |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

### Commands (Command Runner)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `server_id` | INTEGER FK | References `servers(id)`; NULL = local |
| `group_id` | INTEGER FK | References `groups(id)`; NULL = ungrouped |
| `name` | TEXT NOT NULL | Button label |
| `description` | TEXT | |
| `command` | TEXT NOT NULL | Shell command to execute |
| `password_required` | INTEGER DEFAULT 0 | Boolean |
| `is_active` | INTEGER DEFAULT 1 | Boolean |
| `created_by_user_id` | INTEGER FK | |
| `created_at` | TEXT | |
| `updated_at` | TEXT | |

### Command Executions (Command Runner)

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `command_id` | INTEGER FK | References `commands(id)` ON DELETE SET NULL |
| `user_id` | INTEGER FK | References `users(id)` |
| `status` | TEXT NOT NULL | `'pending'` / `'running'` / `'completed'` / `'failed'` |
| `created_at` | TEXT DEFAULT (datetime('now')) | |
| `started_at` | TEXT | |
| `completed_at` | TEXT | |
| `exit_code` | INTEGER | |
| `output` | TEXT | Combined stdout+stderr, max 100 KB |
| `error_summary` | TEXT | First 500 chars of stderr when failed |
| `server_id` | INTEGER | Denormalised for filtering |
| `command_name` | TEXT | Denormalised for display |

---

## 7. Routes Reference

### Web Routes (Server-Rendered)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/` | Public | Redirects to `/dashboard` or `/login` |
| GET | `/login` | Guest only | Login page |
| POST | `/login` | Guest only | Process login |
| POST | `/logout` | Auth | Invalidate session |
| GET | `/dashboard` | Auth | Log card dashboard |
| GET | `/profile` | Auth | View profile |
| POST | `/profile/name` | Auth | Update display name |
| POST | `/profile/password` | Auth | Change password |
| GET | `/admin/groups` | Superadmin | List groups |
| GET | `/admin/groups/new` | Superadmin | New group form |
| POST | `/admin/groups` | Superadmin | Create group |
| GET | `/admin/groups/:id/edit` | Superadmin | Edit group form |
| POST | `/admin/groups/:id` | Superadmin | Update group |
| POST | `/admin/groups/:id/delete` | Superadmin | Delete group |
| GET | `/admin/users` | Superadmin | List users |
| GET | `/admin/users/new` | Superadmin | New user form |
| POST | `/admin/users` | Superadmin | Create user |
| GET | `/admin/users/:id/edit` | Superadmin | Edit user form |
| POST | `/admin/users/:id` | Superadmin | Update user |
| POST | `/admin/users/:id/delete` | Superadmin | Delete user |
| GET | `/admin/users/:id/groups` | Superadmin | Group assignment page |
| POST | `/admin/users/:id/groups` | Superadmin | Update group assignments |
| GET | `/admin/logs` | Superadmin | List all log registrations |
| GET | `/admin/logs/new` | Superadmin | New log form |
| POST | `/admin/logs` | Superadmin | Register log |
| GET | `/admin/logs/:id/edit` | Superadmin | Edit log form |
| POST | `/admin/logs/:id` | Superadmin | Update log |
| POST | `/admin/logs/:id/delete` | Superadmin | Delete log registration |
| GET | `/logs/:id/view` | Auth + Group | Log viewer page |
| GET | `/logs/:id/content` | Auth + Group | Fetch log tail (plain text) |
| GET | `/logs/:id/search` | Auth + Group | Log search page |
| POST | `/logs/:id/clear` | Auth + Group | Clear log file |
| GET | `/commands` | Auth | Command runner dashboard |
| GET | `/commands/history` | Auth | All execution history |
| POST | `/commands/:id/execute` | Auth + Group | Submit command for execution |
| GET | `/commands/:id/executions/:eid` | Auth + Group | Poll execution status |
| GET | `/commands/:id/executions/:eid/view` | Auth + Group | Execution viewer page (live poll + saved output) |
| GET | `/commands/:id/history` | Auth | Per-command execution history |
| GET | `/admin/servers` | Superadmin | List servers |
| GET | `/admin/servers/new` | Superadmin | New server form |
| POST | `/admin/servers` | Superadmin | Create server |
| GET | `/admin/servers/:id/edit` | Superadmin | Edit server form |
| POST | `/admin/servers/:id` | Superadmin | Update server |
| POST | `/admin/servers/:id/delete` | Superadmin | Delete server |
| POST | `/admin/servers/:id/test` | Superadmin | Test server connection |
| GET | `/admin/commands` | Superadmin | List commands |
| GET | `/admin/commands/new` | Superadmin | New command form |
| POST | `/admin/commands` | Superadmin | Create command |
| GET | `/admin/commands/:id/edit` | Superadmin | Edit command form |
| POST | `/admin/commands/:id` | Superadmin | Update command |
| POST | `/admin/commands/:id/delete` | Superadmin | Delete command |

### API Routes

Internal API routes exist under `/api` (referenced in `/src/routes/api/`) for future JSON-based interactions. These are stubs at this stage and are not part of the current functional surface.

---

## 8. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-01 | Security | All POST routes must include a valid CSRF token. Tokens are validated using timing-safe comparison (`crypto.timingSafeEqual`). |
| NFR-02 | Security | Passwords are hashed with **scrypt** via Node.js `crypto`. Plain-text passwords are never stored. |
| NFR-03 | Security | Session tokens are stored in the database; cookie theft without the DB record yields no access. |
| NFR-04 | Security | Role enforcement is applied at the route handler level, not only in the UI. |
| NFR-05 | Performance | The server renders full HTML pages per request — no heavy SPA bundle. Pages should be fast on low-power machines. |
| NFR-06 | Performance | Log content is fetched asynchronously; the viewer page does not block render on log I/O. |
| NFR-07 | Reliability | SQLite migrations run automatically on startup. The system should be bootable with an empty or missing database file. |
| NFR-08 | Portability | The application must run on any Linux/macOS host with Node.js ≥ 18.17 and standard Unix utilities (`tail`, `grep`, `sed`, `truncate`). |
| NFR-09 | Maintainability | No SPA framework, no transpiler, no build step. Source files are executed directly by Node.js with `"type": "module"`. |
| NFR-10 | UX | UI is responsive (Bootstrap 5). The log viewer and dashboard must be usable on mobile. |
| NFR-CMD-01 | Security | SSH credentials are encrypted at rest using AES-256-GCM. The encryption key is stored only in the `.env` file and never in the database. |
| NFR-CMD-02 | Security | Command re‑authentication uses timing‑safe scrypt comparison. No user input is ever concatenated into command strings. |
| NFR-CMD-03 | Reliability | The worker gracefully handles DB connection errors and continues polling. Failed executions are permanently recorded. |
| NFR-CMD-04 | Performance | Command execution does not block HTTP responses. Execution is delegated to the in‑process worker off the request cycle. |
| NFR-CMD-05 | Portability | SSH connections use the `ssh2` npm package (no external SSH binary). Local execution uses `child_process.spawn`. |

---

## 9. Constraints & Assumptions

- **Single-host only.** The application reads log files from the local filesystem of the server it runs on. Remote log sources are not supported.
- **SQLite is the only database.** There is no provision for PostgreSQL, MySQL, or any other database engine.
- **No email integration.** Password resets, invitations, and notifications are not supported. Superadmins must set initial passwords manually.
- **No audit logging.** Actions taken in the UI (user creation, log deletion, etc.) are not tracked in a separate audit trail.
- **Unix-only log I/O.** The system shells out to `tail`, `grep`, `sed`, and `truncate`. It is not compatible with Windows without a POSIX emulation layer.
- **Log files must be accessible** by the OS user running the Node.js process. Permission errors are surfaced to the user as runtime errors in the viewer.
- **Single superadmin entry point.** The CLI seed script is the only way to create or modify superadmin accounts. This is by design to prevent privilege escalation via the web UI.
- **Command execution relies on the OS user** running Bahotasu having necessary permissions on the target server (e.g., to run `sudo` without password if commands require it).
- **The worker and HTTP server share the same Node.js process.** This is acceptable for low‑volume internal tools.
- **SSH servers must be reachable** from the Bahotasu host; no proxy/jump hosts are supported.
- **Only one encryption key exists per installation.** Key rotation requires manual handling.
- **Maximum command output stored is 100 KB.** Longer output is truncated with a visible notice.

---

## 10. Glossary

| Term | Definition |
|---|---|
| **Log Entry / Log Registration** | A record in the `logs` table representing a pointer to a log file on the filesystem, with metadata like tail lines and group association. Not the log content itself. |
| **Group** | A project or team namespace used to bundle related log entries and control which users have access to them. |
| **Superadmin** | The highest privilege role. Created via CLI only. Has unrestricted access to all features and all log files. |
| **User** | A regular authenticated account. Access to logs is scoped to their assigned groups plus any ungrouped logs. |
| **Slug** | A URL-safe, lowercase, alphanumeric identifier for a group. Set at creation time and immutable. |
| **Tail Lines** | The number of lines read from the end of a log file during a content fetch. Configurable per log entry (range: 10–10,000). |
| **Allow Clear** | A per-log flag that, when enabled, permits authenticated users with access to truncate the log file to zero bytes via the UI. |
| **CSRF Token** | A per-session token embedded in all forms to prevent cross-site request forgery attacks. |
| **Session** | A database-backed authentication record tied to a user and a secure random token stored in a browser cookie. |
| **Command** | A named, pre‑approved shell command template defined by a superadmin, linked to a server and optionally a group. No user input is ever interpolated. |
| **Server** | A target for command execution: either the local machine ("This Server") or a remote SSH host with encrypted credentials. |
| **Command Execution** | A row in the `command_executions` queue table representing one invocation of a command by a user, tracking status, output, and audit metadata. |
| **Worker** | An in‑process background `setInterval` loop that processes pending command executions one at a time. |
| **Encryption Key** | A 256‑bit AES‑GCM secret stored in `.env` (`BAHOTASU_ENC_KEY`), auto‑generated on first startup. Used to encrypt/decrypt SSH credentials. |
| **Re‑authentication** | Forcing the user to re‑enter their Bahotasu password before executing a command marked with `password_required = true`. |