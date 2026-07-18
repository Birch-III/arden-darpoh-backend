-- =========================================================================
-- Arden Darpoh Family Land — Database Schema (PostgreSQL)
-- =========================================================================
-- Run via: npm run db:init   (executes this file against DATABASE_URL)
-- Safe to re-run: every statement uses IF NOT EXISTS.
-- =========================================================================

-- ---------- USERS / ADMIN ACCOUNTS ----------
CREATE TABLE IF NOT EXISTS users (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  email            TEXT NOT NULL UNIQUE,
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'sub_admin'
                     CHECK (role IN ('main_admin', 'sub_admin', 'read_only')),
  -- Granular permission strings, ignored for main_admin (who always has full access).
  -- e.g. ["buyers:create","payments:record","documents:upload"]
  permissions      JSONB NOT NULL DEFAULT '[]',
  -- Which groups this user may act on. ["all"] or e.g. ["Group A","Group B"]
  group_scope      JSONB NOT NULL DEFAULT '["all"]',
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  -- Two-factor authentication (TOTP). totp_secret stays NULL until setup is
  -- completed and confirmed with a valid code — see auth.routes.js.
  totp_secret      TEXT,
  totp_enabled     BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       INTEGER REFERENCES users(id)
);

-- Adds 2FA columns for databases created before this feature existed.
-- Safe to run repeatedly (npm run db:init) — does nothing if already present.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---------- LAND GROUPS (ZONES: Group A, B, C ...) ----------
CREATE TABLE IF NOT EXISTS groups (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,          -- "Group A"
  location         TEXT,                          -- "North Ridge"
  total_land_size  NUMERIC NOT NULL DEFAULT 0,     -- total plot CAPACITY for this group (not a count of plot rows created so far — see groups.routes.js for how available_plots is computed from this)
  description      TEXT,
  archived         BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       INTEGER REFERENCES users(id)
);

-- ---------- PLOTS ----------
CREATE TABLE IF NOT EXISTS plots (
  id               SERIAL PRIMARY KEY,
  group_id         INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  plot_number      TEXT NOT NULL UNIQUE,           -- "A-014"
  plot_name        TEXT,                           -- "Riverside Rd, Lot 16"
  plot_size        NUMERIC,                        -- numeric amount
  plot_size_unit   TEXT DEFAULT 'acres',
  latitude         NUMERIC,
  longitude        NUMERIC,
  status           TEXT NOT NULL DEFAULT 'available'
                     CHECK (status IN ('available', 'reserved', 'sold')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- BUYERS ----------
CREATE TABLE IF NOT EXISTS buyers (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL,
  phone            TEXT,
  email            TEXT,
  address          TEXT,
  next_of_kin      TEXT,
  -- existing = already purchased & registered; prospective = reservation/pipeline; disputed = flagged
  status           TEXT NOT NULL DEFAULT 'prospective'
                     CHECK (status IN ('existing', 'prospective', 'disputed')),
  -- Soft delete: NULL = active. Deleting is Main-Admin-only and restorable —
  -- see buyers.routes.js. Never hard-deleted, so payment/audit history survives.
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       INTEGER REFERENCES users(id)
);
ALTER TABLE buyers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- ---------- PURCHASE RECORDS (links a buyer to a plot + grant tracking) ----------
CREATE TABLE IF NOT EXISTS purchase_records (
  id                     SERIAL PRIMARY KEY,
  buyer_id               INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  plot_id                INTEGER NOT NULL REFERENCES plots(id) ON DELETE RESTRICT,
  purchase_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  total_grant_due        NUMERIC NOT NULL DEFAULT 0,
  fully_paid_flag        BOOLEAN NOT NULL DEFAULT false,   -- auto-set once balance reaches 0
  acknowledged_by        INTEGER REFERENCES users(id),     -- manual admin certification
  acknowledgement_date   TIMESTAMPTZ,
  -- Mirrors buyers.deleted_at — set together when the buyer is soft-deleted,
  -- cleared together on restore. See note below on why plot_id is no longer
  -- a plain UNIQUE column constraint.
  deleted_at             TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INTEGER REFERENCES users(id)
);
ALTER TABLE purchase_records ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- A plot should only be tied to one ACTIVE purchase record at a time, but a
-- deleted buyer's old (deleted) purchase record must not block the plot from
-- being sold to someone new. A plain UNIQUE column constraint can't express
-- "unique among active rows only", so: drop the old blanket constraint
-- (Postgres's standard auto-generated name for a single-column UNIQUE
-- constraint) and replace it with a partial unique index instead.
ALTER TABLE purchase_records DROP CONSTRAINT IF EXISTS purchase_records_plot_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS purchase_records_plot_id_active_key
  ON purchase_records(plot_id) WHERE deleted_at IS NULL;

-- ---------- PAYMENTS (grant payment history, many per purchase record) ----------
CREATE TABLE IF NOT EXISTS payments (
  id                   SERIAL PRIMARY KEY,
  purchase_record_id   INTEGER NOT NULL REFERENCES purchase_records(id) ON DELETE CASCADE,
  amount               NUMERIC NOT NULL CHECK (amount > 0),
  payment_date         DATE NOT NULL DEFAULT CURRENT_DATE,
  method               TEXT DEFAULT 'cash',
  receipt_number       TEXT,
  recorded_by          INTEGER REFERENCES users(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- DOCUMENTS (uploaded land documents per buyer/plot) ----------
-- file_path stores the cloud storage key (Cloudinary public_id), not a local disk path.
CREATE TABLE IF NOT EXISTS documents (
  id                   SERIAL PRIMARY KEY,
  buyer_id             INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  purchase_record_id   INTEGER REFERENCES purchase_records(id) ON DELETE SET NULL,
  document_type        TEXT DEFAULT 'other',   -- indenture, site_plan, receipt, id, other
  file_name            TEXT NOT NULL,
  file_path            TEXT NOT NULL,
  resource_type        TEXT DEFAULT 'auto',    -- Cloudinary resource type (image/raw/video)
  file_size_bytes      INTEGER,
  uploaded_by          INTEGER REFERENCES users(id),
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Adds the column for databases created before cloud storage was introduced.
-- Safe to run repeatedly (npm run db:init) — does nothing if the column already exists.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS resource_type TEXT DEFAULT 'auto';

-- Two-factor authentication (TOTP, e.g. Google Authenticator / Authy).
-- totp_secret is only meaningful once totp_enabled is true — a non-null
-- secret with totp_enabled=false just means setup was started but never
-- confirmed with a valid code.
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- ---------- AUDIT LOG (every create/edit/delete/upload/payment/login) ----------
CREATE TABLE IF NOT EXISTS audit_log (
  id             SERIAL PRIMARY KEY,
  user_id        INTEGER REFERENCES users(id),
  action         TEXT NOT NULL,          -- e.g. "buyer.create", "payment.record"
  target_table   TEXT,
  target_id      INTEGER,
  details        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------- Helpful indexes ----------
CREATE INDEX IF NOT EXISTS idx_plots_group_id            ON plots(group_id);
CREATE INDEX IF NOT EXISTS idx_purchase_records_buyer_id  ON purchase_records(buyer_id);
CREATE INDEX IF NOT EXISTS idx_purchase_records_plot_id   ON purchase_records(plot_id);
CREATE INDEX IF NOT EXISTS idx_payments_purchase_record   ON payments(purchase_record_id);
CREATE INDEX IF NOT EXISTS idx_documents_buyer_id         ON documents(buyer_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at       ON audit_log(created_at);
