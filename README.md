# ![Bahotasu Logo](resources/logo.svg)

# Bahotasu · 🪵⚡ Simple log monitoring for real teams

Bahotasu started life as a one-file script for tailing logs. Now it’s a lightweight, role-aware toolkit for ops and developers to peek at and manage logs without the SPA bloat — just pure speed, Bootstrap, and SQLite. 🧠💻

## ✨ Feature Highlights

- 🔐 **Role-based access** – Superadmins manage everything; regular users see only their group’s logs.
- 🗂️ **Group-aware logs** – Tie logs to groups or leave them unassigned for everyone.
- 📜 **Server-side views** – Hono + Bootstrap deliver fast pages optimized for low-power machines and mobile.
- 🧹 **Tail & truncate** – Every log stores its tail-length and optional truncation ability.
- 💾 **SQLite storage** – Self-contained database with migrations nowhere but here.
- 🤝 **User management** – CLI seeds superadmins; UI handles regular users/groups/logs.

---

## 🚀 Quick Start

```bash
git clone https://github.com/ahlamls/bahotasu.git
cd bahotasu

# Install dependencies
npm install

# Create your first superadmin interactively
npm run seed:superadmin

# Development with auto-restart
npm run dev

# Production
npm start
# (Optional) Daemonize with PM2
pm2 start npm --name bahotasu -- start
```

👉 `npm run seed:superadmin` prompts for username, email, name, and password.

## 🧩 Usage Flow

1. **Seed superadmin** – CLI only. This account has full control.
2. **Create groups** – e.g., `awesome_project` with a short description.
3. **Add regular users** – Through the UI. Username/email are fixed once set.
4. **Assign groups to users** – Superadmin UI → User Management → Groups.
5. **Register logs** – Give each log a friendly name, *file path*, tail lines, optional group, and whether truncation is allowed.
6. **Monitor logs** – Users sign in, see grouped log cards, and pop into the log viewer. Auto-refresh/scroll settings persist.

## 🏗️ Stack

- **Runtime**: Node.js + Hono (`@hono/node-server`)
- **Database**: SQLite via `better-sqlite3`
- **Views**: Mustache + Bootstrap 5
- **CLI Seeding**: Node script with secure password hashing (scrypt)
- **Log interaction**: Native `tail` + `truncate` for speed and reliability

## 📁 Project Structure

```
├── src/
│   ├── app.js         # Hono app builder
│   ├── config/        # env loader (dotenv)
│   ├── db/            # better-sqlite3 init + migrations
│   ├── middleware/    # session management
│   ├── models/        # users, groups, logs, sessions
│   ├── routes/        # web + API routes (Hono)
│   ├── views/         # Mustache templates (auth, dashboard, admin, log viewer)
│   └── lib/           # password hashing, cookie helpers, renderer
├── scripts/           # CLI utilities (superadmin seed)
├── resources/         # logos (SVG)
├── index.js           # Entry point
└── README.md          # This file 😄
```

## 🔑 Authentication & Roles

| Role        | Capabilities |
|-------------|--------------|
| Superadmin  | Manage users, groups, logs; view any log. |
| User        | View logs assigned via their groups, update profile, change password. |

👉 Superadmins **cannot** be edited or deleted via UI; use the CLI seeder for new ones.

## 📄 Log Viewer Experience

- Textarea-based output for performance.
- Auto-refresh + auto-scroll toggles with localStorage persistence.
- Truncate button appears only when enabled per log.
- Works great on mobile; entire card acts as a link in the dashboard.

## 💾 Database & Migrations

SQLite file defaults to `./data/bahotasu.sqlite` (configured via `.env`).

Migrations run automatically on startup:

1. Users / Groups / Logs / UserGroups base tables
2. Sessions table
3. Nullable `group_id` for logs
4. Log descriptions

You can safely delete the DB file in development and rerun migrations on next boot.

## ⚙️ Environment

Create `.env` (optional) for:

```
PORT=15415
NODE_ENV=production
SQLITE_FILE=./data/bahotasu.sqlite
```

Defaults: port `4000`, sqlite file `./data/bahotasu.sqlite`, tail lines `1000`.

## 🧪 Testing / Sanity

Manual checklist (recommended):

- Seed superadmin, log in.
- Create group → assign user → log.
- Verify dashboard lists logs correctly by group/unassigned.
- Ensure log viewer tail + truncation works (check filesystem).

## 🤝 Contributing

1. Fork & clone 🚀
2. Create feature branch (`git checkout -b feature`)
3. Run `npm run dev` while coding
4. Submit PR with details

## 📜 License

MIT © 2024 Bahotasu contributors. (just me for now)

Enjoy neat logs! 🪵🕶️
