# Functional Requirements Document (FRD)
## Bahotasu — Command Runner Module

| Field | Value |
|---|---|
| **Project** | Bahotasu |
| **Module** | Command Runner |
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
   - 5.1 Encryption Key Management
   - 5.2 Server Management
   - 5.3 Command Management
   - 5.4 Queue & Worker
   - 5.5 User Execution Flow
   - 5.6 Audit & History
6. [Data Models](#6-data-models)
7. [Routes Reference](#7-routes-reference)
8. [Security Design](#8-security-design)
9. [Non-Functional Requirements](#9-non-functional-requirements)
10. [Constraints & Assumptions](#10-constraints--assumptions)
11. [Glossary](#11-glossary)

---

## 1. Overview

The **Command Runner** module adds secure, asynchronous shell command execution to Bahotasu. Superadmins define pre‑approved commands and assign them to groups. Group members trigger these commands from a dashboard, after explicit confirmation and (optionally) password re‑authentication. Execution is queued in‑process and processed by a background worker; local execution uses the Node.js host, remote execution uses SSH. All SSH credentials are encrypted at rest. Every run is logged for audit.

---

## 2. Goals & Non-Goals

### Goals
- Provide a queue‑based command trigger system with no external dependencies.
- Support execution on the local host and remote servers via SSH.
- Encrypt SSH private keys and passwords using an auto‑generated key.
- Enforce group‑based access control on commands.
- Require confirmation and optional password re‑entry before execution.
- Return command output asynchronously, polled by the client.

### Non-Goals
- Real‑time output streaming; output is captured and returned in full after completion.
- Arbitrary arguments from users; only the exact command defined by superadmin is run.
- Multi‑worker or distributed execution.
- Scheduled or recurring commands.
- Sandboxing beyond the OS user running Bahotasu.

---

## 3. User Roles & Permissions

| Capability | Superadmin | User |
|---|---|---|
| View command dashboard | All commands | Commands in assigned groups + ungrouped |
| Trigger a command | ✅ | ✅ |
| View own execution history | ✅ | ✅ |
| View all execution history | ✅ | ❌ |
| Manage servers (CRUD) | ✅ | ❌ |
| Manage commands (CRUD) | ✅ | ❌ |

---

## 4. System Architecture
User clicks "Execute" → POST /commands/:id/execute
→ Server validates, inserts command_execution (status=pending)
→ Returns { execution_id }
User polls GET /commands/:id/executions/:eid

Worker (setInterval 1s):
SELECT * FROM command_executions WHERE status='pending' ORDER BY created_at ASC LIMIT 1
→ UPDATE status='running'
→ Execute (local spawn or ssh2)
→ UPDATE status, output, exit_code

text

The worker runs inside the same Node.js process as the HTTP server, using `better-sqlite3` for direct DB access.

---

## 5. Functional Requirements

### 5.1 Encryption Key Management

**FR-ENC-01 – Auto‑generation**  
On startup, if `process.env.BAHOTASU_ENC_KEY` is not set, the server generates a 32‑byte random hex string and appends it to the `.env` file, then loads it. If `.env` is not writable, the server exits with an error.

**FR-ENC-02 – Encrypt / Decrypt**  
A shared encryption module provides:
- `encrypt(plain: string): string` – AES‑256‑GCM, returns base64 (IV + auth tag + ciphertext).
- `decrypt(cipher: string): string` – reverses the process; throws on invalid data.
Only SSH credentials from the `servers` table are encrypted/decrypted with this module.

### 5.2 Server Management

All server routes require superadmin.

**FR-SRV-01 – Seed “This Server”**  
A migration inserts a server record representing the local machine: `host = NULL`, `auth_type = 'local'`, name = `"This Server"`. It cannot be deleted.

**FR-SRV-02 – List servers**  
`GET /admin/servers` – shows name, host/”Local”, auth type for all servers.

**FR-SRV-03 – Create server**  
`POST /admin/servers`:
- Required: name, host (unless local), auth method (`key` or `password`), credential.
- Credential encrypted before insert.
- Port defaults to 22.

**FR-SRV-04 – Edit server**  
`POST /admin/servers/:id` – updates name, host, port, credential (if new credential provided, it replaces the old one after re‑encryption).

**FR-SRV-05 – Delete server**  
`POST /admin/servers/:id/delete` – removes server; commands referencing it get `server_id` set to NULL. “This Server” is undeletable.

**FR-SRV-06 – Test connection**  
`POST /admin/servers/:id/test` – tries a simple `echo OK` (local or SSH), returns success/failure message without exposing credentials.

### 5.3 Command Management

All command management routes require superadmin.

**FR-CMD-01 – List commands**  
`GET /admin/commands` – paginated list showing name, server, group, `is_active`.

**FR-CMD-02 – Create command**  
`POST /admin/commands`:
- Fields: name, description, command string, server (dropdown), group (optional), `password_required` (bool), `is_active` (default true).
- The command string is a fixed shell command; no user input is ever interpolated.

**FR-CMD-03 – Edit command**  
`POST /admin/commands/:id` – updates all fields; does not affect queued/running executions.

**FR-CMD-04 – Delete command**  
`POST /admin/commands/:id/delete` – deletes command; associated execution history rows keep their `command_id` as NULL (soft reference).

**FR-CMD-05 – Toggle active**  
Can be done via edit (setting `is_active`). Disabled commands cannot be executed.

### 5.4 Queue & Worker

**FR-QUE-01 – Queue table**  
`command_executions` table stores each request with `status` (`pending`, `running`, `completed`, `failed`).

**FR-QUE-02 – Worker startup**  
The worker starts when the HTTP server starts, using `setInterval` to poll every 1 second.

**FR-QUE-03 – Worker processing**  
- Picks the oldest `pending` row.
- Sets status to `running` and records `started_at`.
- Executes the command string against the target server (local or SSH).
- Captures stdout and stderr combined, truncates at 100 KB.
- Sets `status = 'completed'` and `exit_code` if successful, or `status = 'failed'` with `error_summary` (first 500 chars of stderr).
- Stores output in `output` column.

**FR-QUE-04 – Timeout**  
Commands that run longer than a configurable timeout (default 30 seconds) are killed and marked as `failed`.

**FR-QUE-05 – Concurrency**  
The worker processes one execution at a time (single‑threaded). If an execution is already running, the next poll waits.

### 5.5 User Execution Flow

**FR-EXEC-01 – Command dashboard**  
`GET /commands` displays command cards grouped by project group (like the log dashboard). Each card shows command name, description, and an “Execute” button.

**FR-EXEC-02 – Access control**  
A user sees only commands where:
- Command belongs to a group the user is a member of, OR command is ungrouped.
- Superadmins see all.

**FR-EXEC-03 – Confirmation modal**  
Clicking “Execute” opens a Bootstrap modal that:
- Displays the command name and a warning.
- If `password_required = true`, includes a password input.
- Has “Confirm” and “Cancel” buttons.

**FR-EXEC-04 – Re‑authentication**  
If `password_required`, the provided password is verified against the user’s scrypt hash using timing‑safe comparison. Failure blocks execution.

**FR-EXEC-05 – Queue submission**  
`POST /commands/:id/execute`:
- Validates: command exists, is active, user access, password if required, CSRF token.
- Inserts a row into `command_executions` with status `pending`, user ID, command ID, timestamp.
- Returns JSON `{ execution_id, status: 'queued' }`.

**FR-EXEC-06 – Polling for result**  
The client polls `GET /commands/:id/executions/:execution_id` every 2 seconds until `status` is `completed` or `failed`.
- Response includes `status`, `output` (if completed), `exit_code`, `error_summary`.
- Access to the execution record is restricted: only the owning user (or superadmin) can view it.

**FR-EXEC-07 – Display output**  
When completed, the modal or a result panel shows the command output in a scrollable `<pre>` block. On failure, the error summary is shown.

### 5.6 Audit & History

**FR-AUD-01 – Automatic logging**  
Every execution creates a permanent record in `command_executions`. No explicit user action is needed.

**FR-AUD-02 – History view (user)**  
`GET /commands/:id/history` (or `/commands/history`) shows the user’s own past executions for that command, with status, timestamp, and output length.

**FR-AUD-03 – History view (superadmin)**  
Superadmins can view all execution records, filterable by command, server, user, status.

---

## 6. Data Models

### 6.1 `servers`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| name | TEXT NOT NULL | |
| description | TEXT | |
| host | TEXT | NULL for local |
| port | INTEGER DEFAULT 22 | |
| auth_type | TEXT NOT NULL | `'key'`, `'password'`, or `'local'` |
| encrypted_private_key | TEXT | AES‑256‑GCM encrypted PEM |
| encrypted_password | TEXT | AES‑256‑GCM encrypted password |
| is_local | INTEGER GENERATED | (host IS NULL) – not a real column; logical flag |
| created_at | TEXT | |
| updated_at | TEXT | |

The “This Server” record is inserted once during migration: `host = NULL`, `auth_type = 'local'`.

### 6.2 `commands`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| server_id | INTEGER FK | References `servers(id)`; NULL = local |
| group_id | INTEGER FK | References `groups(id)`; NULL = ungrouped |
| name | TEXT NOT NULL | Button label |
| description | TEXT | |
| command | TEXT NOT NULL | Shell command to execute |
| password_required | INTEGER DEFAULT 0 | Boolean |
| is_active | INTEGER DEFAULT 1 | Boolean |
| created_by_user_id | INTEGER FK | |
| created_at | TEXT | |
| updated_at | TEXT | |

### 6.3 `command_executions`

| Column | Type | Notes |
|---|---|---|
| id | INTEGER PK | |
| command_id | INTEGER FK | References `commands(id)` ON DELETE SET NULL |
| user_id | INTEGER FK | References `users(id)` |
| status | TEXT NOT NULL | `'pending'` / `'running'` / `'completed'` / `'failed'` |
| created_at | TEXT DEFAULT (datetime('now')) | |
| started_at | TEXT | |
| completed_at | TEXT | |
| exit_code | INTEGER | |
| output | TEXT | Combined stdout+stderr, max 100 KB |
| error_summary | TEXT | First 500 chars of stderr when failed |
| server_id | INTEGER | Denormalised for filtering |
| command_name | TEXT | Denormalised for display |

Unique index on `(id, user_id)` is not needed; access control enforced in app logic.

---

## 7. Routes Reference

### 7.1 Superadmin Routes (servers & commands)

| Method | Path | Description |
|---|---|---|
| GET | `/admin/servers` | List servers |
| GET / POST | `/admin/servers/new`, `/admin/servers` | Create server |
| GET / POST | `/admin/servers/:id/edit`, `/admin/servers/:id` | Edit server |
| POST | `/admin/servers/:id/delete` | Delete server |
| POST | `/admin/servers/:id/test` | Test connection |
| GET | `/admin/commands` | List commands |
| GET / POST | `/admin/commands/new`, `/admin/commands` | Create command |
| GET / POST | `/admin/commands/:id/edit`, `/admin/commands/:id` | Edit command |
| POST | `/admin/commands/:id/delete` | Delete command |

All superadmin routes require the `superadmin` role and CSRF protection.

### 7.2 User‑facing Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/commands` | Auth | Command dashboard (cards) |
| POST | `/commands/:id/execute` | Auth + Group | Submit command for execution |
| GET | `/commands/:id/executions/:execution_id` | Auth + Group | Poll execution status/output |
| GET | `/commands/:id/history` | Auth | View own execution history |

---

## 8. Security Design

| Threat | Mitigation |
|---|---|
| SSH credentials stolen from DB | AES‑256‑GCM encryption; key never stored in DB, auto‑generated per environment |
| User triggers command without permission | Access checked per route: group membership + command existence + active status |
| User bypasses password re‑authentication | `password_required` forces re‑validation using scrypt + timingSafeEqual |
| Command injection | Only the exact command string is executed; no user input is concatenated |
| Session hijacking to execute commands | CSRF token required on POST `/commands/:id/execute` |
| Output data leaked to other users | Polling endpoint verifies `execution.user_id === currentUser.id` (or superadmin) |
| Cross‑origin framing / clickjacking | All responses include `X-Frame-Options: DENY` header |
| Brute‑force of password re‑entry | No specific rate limit (low risk), but audit log captures every attempt |
| Long‑running command blocks server | Worker times out after 30s; single‑threaded queue prevents overload |
| Encrypted key exposure in logs | Encryption key never logged; error messages do not include plaintext credentials |

---

## 9. Non-Functional Requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-CMD-01 | Reliability | The worker must gracefully handle DB connection errors and continue polling. |
| NFR-CMD-02 | Performance | Command execution must not block HTTP responses; execution handled off the request cycle. |
| NFR-CMD-03 | Portability | SSH connections use `ssh2` npm package, no external SSH binary required. Local execution uses `child_process.spawn`. |
| NFR-CMD-04 | Maintainability | Encryption logic is a single module; worker is a simple setInterval loop. |
| NFR-CMD-05 | UX | Polling interval should be adjustable (default 2s); output displayed in a readable format. |

---

## 10. Constraints & Assumptions

- The worker and HTTP server share the same Node.js process. This is acceptable for low‑volume internal tools.
- The SSH server must be reachable from the Bahotasu host; no proxy/jump hosts are supported in v1.
- Only one encryption key exists per installation; key rotation requires manual handling.
- Command execution relies on the OS user running Bahotasu having necessary permissions (e.g., to run `sudo` without password if defined).
- The maximum output stored is 100 KB; longer output is truncated with a visible notice.
- The module adds no new external dependencies beyond `ssh2`.

---

## 11. Glossary

| Term | Definition |
|---|---|
| **Command** | A named shell command template defined by a superadmin, linked to a server and optionally a group. |
| **Server** | A target for execution: either the local machine (“This Server”) or a remote SSH host. |
| **Queue** | The `command_executions` table used to decouple request from execution. |
| **Worker** | In‑process background loop that processes pending executions. |
| **Encryption Key** | A 256‑bit secret stored in `.env` used to encrypt/decrypt SSH credentials. |
| **Re‑authentication** | Forcing the user to re‑enter their Bahotasu password before executing a sensitive command. |