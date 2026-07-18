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

## 3.5 Document storage (Cloudinary)

Uploaded land documents (indentures, site plans, receipts, IDs) are stored
in **Cloudinary**, not on local disk. This matters because most hosting
platforms (including Render's free tier) wipe local files on every restart
or redeploy — Cloudinary keeps them permanently, independent of your server.

**Setup (free, ~2 minutes):**
1. Sign up at [cloudinary.com](https://cloudinary.com) (free tier: 25GB storage).
2. On your Dashboard, find **"Product Environment Credentials"** and copy
   the Cloud name, API Key, and API Secret.
3. Add them to your `.env`:
   ```
   CLOUDINARY_CLOUD_NAME=your-cloud-name
   CLOUDINARY_API_KEY=your-api-key
   CLOUDINARY_API_SECRET=your-api-secret
   ```
4. Add the same three variables to your Render service's **Environment** tab.
5. If you already have a live database from before this change, run
   `npm run db:init` again — it safely adds the new `resource_type` column
   to your existing `documents` table without touching any existing data.

The storage backend is swappable — see `src/services/documentStorage.js`.
The test suite injects a fake in-memory backend instead of calling out to
Cloudinary, so `npm test` doesn't need real credentials to pass.

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
`groups:manage`, `buyers:create`, `buyers:edit`,
`payments:record`, `payments:delete`, `documents:upload`, `documents:delete`,
`reports:view`.

Note: `buyers:delete` is no longer a delegable permission. Deleting a buyer
is deliberately hard-coded to Main-Admin-only (`requireMainAdmin`, not
`requirePermission`) — see §5.6 below for why.

A sub-admin's `permissions` and `group_scope` are plain JSON arrays on their
user row — the Main Admin sets these when creating or editing an account via
`POST /api/admin/users` / `PATCH /api/admin/users/:id`.

Group scope is enforced on every group-relevant write: creating a buyer,
editing a buyer, recording/acknowledging/deleting a payment, and
uploading/deleting a document all check that the buyer's group is inside the
acting user's `group_scope` (or that it's `["all"]`). See `tests/smoke.test.js`
for a working example of this being denied.

---

## 5.6 Buyer deletion, restore, and group plot capacity

**Soft delete, not hard delete.** Deleting a buyer never actually removes
their row from the database — it sets `deleted_at`, which every query in
the app then filters out. This means:
- Deleted buyers disappear from every list, folder, dashboard, and report.
- Their plot is immediately freed up (`status` reset to `available`) so it
  can be sold to someone new.
- Their full payment history, documents, and audit trail are preserved and
  can be brought back at any time via **Admin & Users → Deleted Buyers →
  Restore** (Main Admin only, `POST /api/buyers/:id/restore`).
- If the freed-up plot gets sold to a *different* buyer before the original
  is restored, restoring still brings the original buyer's account and
  history back — it just won't reclaim the plot out from under its new
  owner. The API response includes `plot_reclaimed: true/false` so the UI
  can explain this; the frontend shows a toast either way.

**Why Main-Admin-only, not a delegable permission:** removing someone's
land record is sensitive enough that it's hard-coded to the one account
with full accountability, rather than something a sub-admin permission
toggle could grant. Restore works the same way.

**Group plot capacity (`total_land_size`).** A group's "available plots"
count is driven by this single declared-capacity number, not by counting
individual plot rows — most available plots never get an explicit row
created for them (only sold, reserved, or manually pre-registered ones
do). `available_plots = total_land_size - (sold + reserved)`, computed
fresh on every request. This is set when creating a group, and can be
changed later via **Groups & Plots → open a group → Edit Group**
(`PATCH /api/groups/:id`), which is blocked from going below however many
plots are already sold/reserved. Creating a *new* buyer on a *new* plot
number is also blocked once a group is at capacity — pre-existing plot
numbers (e.g. re-registering on a plot freed by a deleted buyer) are
exempt from this check, since that's a resale, not new capacity being used.

---

## 5.5 Security hardening

A few protections worth knowing about, since this holds real land and
financial records:

- **Rate limiting on login and password-change** (`src/middleware/rateLimiters.js`).
  8 attempts per 15 minutes per IP on `/api/auth/login`. This blocks by
  request volume, not just failed-password count — even correct-password
  requests get throttled once the limit is hit, which is what actually
  stops scripted brute-force attempts. `app.set('trust proxy', 1)` in
  `app.js` is required for this to correctly identify clients behind
  Render's (or any host's) reverse proxy — without it, rate limiting either
  can't tell users apart or misfires.

- **Authorization is re-checked on every request, not just at login**
  (`src/middleware/auth.js`). The JWT only proves *identity* (a user id) —
  role, permissions, group_scope, and account status are looked up fresh
  from the database on every single request. This means disabling a user
  or changing their permissions takes effect **immediately**, not after
  their existing token happens to expire (previously up to 12 hours). This
  is the more important of the two fixes here — see `e2e-security.js`-style
  reasoning in the test suite for why it matters.

- **Password policy** (`src/utils/passwordPolicy.js`): minimum 8
  characters, must include at least one letter and one number. Applied on
  both self-service password changes and admin-created accounts.

- **Two-factor authentication (TOTP)** — any user can enable it from the
  "Security" link in the sidebar: scan a QR code with an authenticator app
  (Google Authenticator, Authy, etc.), confirm with a code, done. Once
  enabled:
  - Login becomes two steps: password first, then a 6-digit code. The
    password step issues a short-lived (5 min) "pending" token that is
    **cryptographically distinct** from a real session token (carries
    `purpose: 'mfa_pending'`) — `requireAuth` explicitly rejects that
    purpose on every other route, so a stolen pending token is useless on
    its own. This is verified directly in `e2e-2fa.js`.
  - The 6-digit code endpoints are separately rate-limited
    (`mfaVerifyLimiter`) — a 6-digit code is only 1 million possibilities,
    which is brute-forceable without a limiter.
  - Disabling 2FA requires the current password, not just being logged in.
  - I'd recommend enabling this on the Main Admin account specifically,
    since it holds unrestricted control.
  - Uses `otplib` v13's functional API (`generateSecret`/`generate`/`verify`/
    `generateURI` — not the older class-based `authenticator` object from
    v11/v12, which has a different shape) and `qrcode` for the scannable
    image. See `src/services/totp.js`.

**Migrating an existing live database:** 2FA adds two new columns
(`totp_secret`, `totp_enabled`) to the `users` table. Run `npm run db:init`
again after deploying this update — it safely adds them via `ALTER TABLE
... ADD COLUMN IF NOT EXISTS`, without touching any existing rows or data.

**Still open** — see Next Steps below for what I'd still want added before
calling this fully hardened against a determined attacker (as opposed to
secure for trusted day-to-day family use, which it already is).

---

## 6. API reference (summary)

All routes except `/api/health` and `/api/auth/login` require
`Authorization: Bearer <token>`.

| Method & Path | Purpose | Permission |
|---|---|---|
| POST `/api/auth/login` | Log in (or start 2FA if enabled) | — |
| POST `/api/auth/2fa/verify` | Second step of login when 2FA is on | — (needs valid `mfa_token`) |
| GET `/api/auth/me` | Current user | any logged-in user |
| PATCH `/api/auth/me/password` | Change your own password | any (needs current password) |
| GET `/api/auth/2fa/setup` | Start 2FA setup, returns QR code | any |
| POST `/api/auth/2fa/enable` | Confirm setup with a code | any |
| POST `/api/auth/2fa/disable` | Turn off 2FA | any (needs current password) |
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
| GET `/api/buyers/deleted` | List soft-deleted buyers | Main Admin only |
| POST `/api/buyers` | Register new buyer + plot + purchase record | `buyers:create` |
| PATCH `/api/buyers/:id` | Edit buyer info | `buyers:edit` |
| DELETE `/api/buyers/:id` | Soft-delete buyer, frees their plot | Main Admin only |
| POST `/api/buyers/:id/restore` | Restore a soft-deleted buyer | Main Admin only |
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

Done: frontend wired to real endpoints, documents moved to Cloudinary,
login rate limiting, immediate permission/disable enforcement, password
policy, **two-factor authentication (TOTP)**. Still worth adding, roughly
in priority order:

1. **Self-service "forgot password"** flow — right now, recovery depends on
   the Main Admin running `src/db/set-password.js` directly, or having
   direct database access. Fine for a small trusted circle, but a real gap
   for anyone locked out without that access. Note: this needs to interact
   sensibly with 2FA once built — a password-reset flow that skips the
   second factor would undermine it.
2. **File content verification on uploads** — `documents.routes.js`
   currently checks file type by filename extension only, not actual file
   content. Low real-world risk here (files are stored/downloaded, never
   executed), but worth tightening with a magic-byte check.
3. **A "download everything" export tool** — full data export independent
   of any single hosting provider, for peace of mind.
4. **A proper "My Profile" screen** in the frontend so the Main Admin isn't
   the only one who can self-service basic account details.
5. Verify Neon's actual backup/retention policy on the free tier rather
   than assuming — and consider a periodic automated export as a belt-and-
   suspenders backup regardless of what the host provides.
