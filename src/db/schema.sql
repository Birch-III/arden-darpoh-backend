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
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       INTEGER REFERENCES users(id)
);

-- ---------- LAND GROUPS (ZONES: Group A, B, C ...) ----------
CREATE TABLE IF NOT EXISTS groups (
  id               SERIAL PRIMARY KEY,
  name             TEXT NOT NULL UNIQUE,          -- "Group A"
  location         TEXT,                          -- "North Ridge"
  total_land_size  NUMERIC NOT NULL DEFAULT 0,     -- total plots allocated to this group
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
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       INTEGER REFERENCES users(id)
);

-- ---------- PURCHASE RECORDS (links a buyer to a plot + grant tracking) ----------
CREATE TABLE IF NOT EXISTS purchase_records (
  id                     SERIAL PRIMARY KEY,
  buyer_id               INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  plot_id                INTEGER NOT NULL UNIQUE REFERENCES plots(id) ON DELETE RESTRICT,
  purchase_date          DATE NOT NULL DEFAULT CURRENT_DATE,
  total_grant_due        NUMERIC NOT NULL DEFAULT 0,
  fully_paid_flag        BOOLEAN NOT NULL DEFAULT false,   -- auto-set once balance reaches 0
  acknowledged_by        INTEGER REFERENCES users(id),     -- manual admin certification
  acknowledgement_date   TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             INTEGER REFERENCES users(id)
);

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
CREATE TABLE IF NOT EXISTS documents (
  id                   SERIAL PRIMARY KEY,
  buyer_id             INTEGER NOT NULL REFERENCES buyers(id) ON DELETE CASCADE,
  purchase_record_id   INTEGER REFERENCES purchase_records(id) ON DELETE SET NULL,
  document_type        TEXT DEFAULT 'other',   -- indenture, site_plan, receipt, id, other
  file_name            TEXT NOT NULL,
  file_path            TEXT NOT NULL,
  file_size_bytes      INTEGER,
  uploaded_by          INTEGER REFERENCES users(id),
  uploaded_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
