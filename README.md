# Arden Darpoh Family Land — Backend API

A real Node.js + PostgreSQL backend for the Arden Darpoh Family Land management
system: land groups/plots, buyer folders, grant payment tracking, document
uploads, role-based admin access, and a full audit trail.

This is designed to sit behind the clickable frontend mockup you already
reviewed, and to be hosted online (Render, Railway, Supabase, Fly.io, a VPS —
anything that runs Node.js and gives you a Postgres database).

---

## 1. Tech stack & why

| Layer | Choice | Why |
|---|---|---|
| Server | Node.js + Express | Simple, well understood, easy to deploy anywhere |
| Database | PostgreSQL | Real relational integrity for money/ownership data; every major host offers a free/cheap tier |
| DB access | raw SQL via `pg` | No native compilation required, no ORM "magic" — every query is visible and auditable |
| Auth | JWT + bcryptjs | Stateless sessions; bcryptjs is pure JS (no native build issues) |
| File uploads | multer | Battle-tested, stores documents to disk (see note on storage below) |

**No SQLite.** Most hosting platforms (Render, Railway, Heroku-likes) wipe the
local filesystem on every deploy — a SQLite file would silently lose all your
land records. PostgreSQL is the right choice for anything you're calling
"hosted online."

---

## 2. Project structure

```
backend/
  src/
    app.js                 Express app wiring (routes, middleware)
    server.js               Entry point — starts the HTTP server
    db/
      schema.sql             Full table definitions (run once to set up the DB)
      seed.js                 Sample data matching the mockup (optional)
      init.js                 Runs schema.sql against DATABASE_URL
      pool.js                 PostgreSQL connection pool
    middleware/
      auth.js                 Verifies JWT, attaches req.user
      permissions.js          Role/permission/group-scope checks
      auditLog.js             Writes to the audit_log table
      errorHandler.js         Central error → HTTP response mapping
    routes/
      auth.routes.js          POST /login, GET /me
      groups.routes.js        Land groups (zones) CRUD + rollup stats
      plots.routes.js         Individual plot records
      buyers.routes.js        Buyer folders, registration, search/filter
      payments.routes.js      Grant payments, balances, acknowledgement
      documents.routes.js     Upload/download/delete land documents
      admin.routes.js         Admin/sub-admin account management, audit log
      reports.routes.js       Land availability / grant / buyer directory reports
      dashboard.routes.js     Town-wide KPIs for the overview screen
  tests/
    smoke.test.js            End-to-end test suite (no real DB needed — see below)
  uploads/                   Uploaded documents land here (gitignore this in real use)
  .env.example
  package.json
```

---

## 3. Local setup

### Prerequisites
- Node.js 18+
- A PostgreSQL database — either:
  - Local: `docker run --name land-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres`
  - Or a free hosted one: [Neon](https://neon.tech), [Supabase](https://supabase.com), or Render's free Postgres

### Steps
```bash
cd backend
npm install
cp .env.example .env
# edit .env — paste your DATABASE_URL and set a real JWT_SECRET

npm run db:init     # creates all tables
npm run db:seed     # (optional) loads sample groups/buyers/payments for testing

npm start           # runs on http://localhost:4000
```

The seed script prints two logins you can use immediately:
```
Main Admin  → admin@ardendarpoh.family   / ChangeMe123!
Sub-Admin   → sarah@ardendarpoh.family   / ChangeMe123!
```
**Change these passwords (or delete the seeded users) before going live.**

### Running the test suite
```bash
npm test
```
This runs the real Express app and the real `schema.sql` against **pg-mem**,
a pure-JavaScript in-memory PostgreSQL emulator — so you can verify auth,
permissions, and the full buyer/payment workflow without installing Postgres
locally. It currently passes 26/26 checks covering login, permission denial,
group-scope enforcement, buyer registration, partial/full payments, balance
calculation, acknowledgement, dashboard totals, and report access control.

> pg-mem is a test-only convenience and has a couple of known quirks (noted in
> the test file). Always do a final pass against real Postgres before
> launching.

---

## 4. Deploying it "online"

Any Node host works. A simple, cheap path:

1. **Database:** Create a free Postgres instance on [Neon](https://neon.tech) or [Supabase](https://supabase.com). Copy its connection string.
2. **API:** Push this `backend/` folder to a GitHub repo, then create a new **Web Service** on [Render](https://render.com) (or Railway/Fly.io):
   - Build command: `npm install`
   - Start command: `npm start`
   - Environment variables: paste in `DATABASE_URL`, `JWT_SECRET`, `CORS_ORIGIN` (your frontend's URL), `PORT` (Render sets this automatically).
3. Run `npm run db:init` once against the production `DATABASE_URL` (e.g. via Render's shell, or locally by temporarily pointing your `.env` at it) to create the tables. Skip `db:seed` in production — create your real Main Admin manually instead (see below).
4. Point the frontend at your API's URL.

### Creating the real first Main Admin (production)
The seed script is for demos only. For a real launch, insert the first Main
Admin directly:
```bash
node -e "
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getPool } = require('./src/db/pool');
(async () => {
  const hash = await bcrypt.hash('YOUR-STRONG-PASSWORD', 10);
  await getPool().query(
    \`INSERT INTO users (name, email, password_hash, role, permissions, group_scope)
     VALUES (\$1, \$2, \$3, 'main_admin', '[]', '[\"all\"]')\`,
    ['Your Name', 'you@example.com', hash]
  );
  console.log('Main Admin created.');
  process.exit(0);
})();
"
```

### File storage note
Documents currently save to the `uploads/` folder on disk. That's fine for a
single-server deployment, but most hosting platforms also wipe local disk on
redeploy. For production, the recommended upgrade is to swap
`documents.routes.js`'s disk storage for a cloud bucket (e.g. AWS S3,
Cloudflare R2, or Supabase Storage) — the route logic barely changes, only
where `multer` writes the file.

---

## 5. Roles & permissions

| Role | Behavior |
|---|---|
| `main_admin` | Bypasses every permission check. Only role that can create/edit other admin accounts. |
| `sub_admin` | Must hold the specific permission string for an action, and (for group-scoped resources) have that group in `group_scope`. |
| `read_only` | Can call any `GET` route but holds no permissions, so every write is denied. |

Permission strings currently checked in the code:
`groups:manage`, `buyers:create`, `buyers:edit`, `buyers:delete`,
`payments:record`, `payments:delete`, `documents:upload`, `documents:delete`,
`reports:view`.

A sub-admin's `permissions` and `group_scope` are plain JSON arrays on their
user row — the Main Admin sets these when creating or editing an account via
`POST /api/admin/users` / `PATCH /api/admin/users/:id`.

Group scope is enforced on every group-relevant write: creating a buyer,
editing/deleting a buyer, recording/acknowledging/deleting a payment, and
uploading/deleting a document all check that the buyer's group is inside the
acting user's `group_scope` (or that it's `["all"]`). See `tests/smoke.test.js`
for a working example of this being denied.

---

## 6. API reference (summary)

All routes except `/api/health` and `/api/auth/login` require
`Authorization: Bearer <token>`.

| Method & Path | Purpose | Permission |
|---|---|---|
| POST `/api/auth/login` | Log in | — |
| GET `/api/auth/me` | Current user | any logged-in user |
| GET `/api/dashboard` | Town-wide KPIs | any |
| GET `/api/groups` | List groups + rollup stats | any |
| GET `/api/groups/:id` | Group detail + its plots/buyers | any |
| POST `/api/groups` | Create group | `groups:manage` |
| PATCH `/api/groups/:id` | Rename/resize group | `groups:manage` |
| DELETE `/api/groups/:id` | Archive group | `groups:manage` |
| GET `/api/plots` | List plots (filter by group/status) | any |
| POST `/api/plots` | Pre-register an available plot | `groups:manage` |
| GET `/api/buyers` | List/filter/search buyers | any |
| GET `/api/buyers/:id` | Full buyer folder | any |
| POST `/api/buyers` | Register new buyer + plot + purchase record | `buyers:create` |
| PATCH `/api/buyers/:id` | Edit buyer info | `buyers:edit` |
| DELETE `/api/buyers/:id` | Delete buyer | `buyers:delete` |
| GET `/api/payments` | Town-wide payment status list | any |
| POST `/api/payments` | Record a grant payment | `payments:record` |
| POST `/api/payments/purchase-records/:id/acknowledge` | Certify fully paid | `payments:record` |
| DELETE `/api/payments/:id` | Correct a mis-entered payment | `payments:delete` |
| POST `/api/documents/:buyerId` | Upload a document | `documents:upload` |
| GET `/api/documents/:id/download` | Download a document | any |
| DELETE `/api/documents/:id` | Delete a document | `documents:delete` |
| GET `/api/admin/users` | List admin accounts | Main Admin only |
| POST `/api/admin/users` | Create sub-admin/read-only account | Main Admin only |
| PATCH `/api/admin/users/:id` | Edit permissions/scope/status | Main Admin only |
| GET `/api/admin/audit-log` | Recent system activity | Main Admin only |
| GET `/api/reports/land-availability` | Sold/available per group | `reports:view` |
| GET `/api/reports/grant-payments` | Every buyer's grant status + aging | `reports:view` |
| GET `/api/reports/buyer-directory` | Full buyer contact/plot list | `reports:view` |

---

## 7. Next steps

1. Wire the frontend mockup's buttons/tables to these endpoints (replace the
   hardcoded sample arrays with `fetch()` calls).
2. Move file uploads to cloud storage before a real launch.
3. Add password-reset / "forgot password" flow for admins.
4. Consider a lightweight rate limiter on `/api/auth/login`.
