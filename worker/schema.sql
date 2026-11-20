-- Elite Cuts API, D1 (SQLite) schema.
-- Apply with:  npx wrangler d1 execute elite-cuts --remote --file=schema.sql
-- Safe to re-run: every statement is IF NOT EXISTS.

-- D1 enforces foreign keys by default.

-- One row per client, keyed by phone digits only ("+1 (555) 234-5678" -> "15552345678").
CREATE TABLE IF NOT EXISTS customers (
  phone       TEXT PRIMARY KEY CHECK (phone <> '' AND phone NOT GLOB '*[^0-9]*'),
  name        TEXT NOT NULL,
  phone_raw   TEXT NOT NULL,            -- as the client typed it, for display
  last_visit  TEXT,                     -- YYYY-MM-DD of their latest booking
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id              TEXT PRIMARY KEY,
  ref_code        TEXT NOT NULL UNIQUE,                     -- e.g. EC-4821, used as Stripe client_reference_id
  customer_phone  TEXT NOT NULL REFERENCES customers(phone),
  client_name     TEXT NOT NULL,
  client_phone    TEXT NOT NULL,
  services        TEXT NOT NULL CHECK (json_valid(services) AND json_type(services) = 'array'),
  total_cost      REAL NOT NULL DEFAULT 0,
  total_min       INTEGER NOT NULL DEFAULT 0,
  barber_id       TEXT NOT NULL,
  barber_name     TEXT NOT NULL,
  date            TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  time            TEXT NOT NULL,                            -- slot label, e.g. "11:00 AM" (same as the PWA)
  notes           TEXT NOT NULL DEFAULT '',
  payment_mode    TEXT NOT NULL CHECK (payment_mode IN ('deposit', 'chair')),
  deposit_amount  REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('Confirmed', 'Deposit Unpaid', 'Paid', 'Completed', 'Cancelled', 'No-Show')),
  paid            INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  paid_at         TEXT,
  late_minutes    INTEGER,                                  -- set by "Running late" in the chat
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at      TEXT
);

-- THE important one: a barber can hold only one active booking per date+time.
-- Cancelled bookings drop out of the index, so a cancelled slot can be re-booked.
-- Two clients racing for the same slot: the database accepts exactly one INSERT.
CREATE UNIQUE INDEX IF NOT EXISTS bookings_one_active_per_slot
  ON bookings (barber_id, date, time)
  WHERE status <> 'Cancelled';

CREATE INDEX IF NOT EXISTS bookings_by_date       ON bookings (date, time);
CREATE INDEX IF NOT EXISTS bookings_by_customer   ON bookings (customer_phone, date);
CREATE INDEX IF NOT EXISTS bookings_by_created    ON bookings (created_at);

-- Append-only ledger. Points and stamp counts are derived from it, never stored twice.
CREATE TABLE IF NOT EXISTS loyalty_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  phone       TEXT NOT NULL REFERENCES customers(phone),
  booking_id  TEXT REFERENCES bookings(id),
  kind        TEXT NOT NULL CHECK (kind IN ('booking', 'deposit_paid', 'adjustment')),
  points      INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- A booking earns each kind of award at most once (Stripe retries webhooks; this makes them harmless).
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_once_per_booking
  ON loyalty_events (booking_id, kind)
  WHERE booking_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS loyalty_by_phone ON loyalty_events (phone, created_at);

-- Manager-login brute-force guard: failed PIN attempts per client IP.
CREATE TABLE IF NOT EXISTS login_attempts (
  ip            TEXT PRIMARY KEY,
  fails         INTEGER NOT NULL DEFAULT 0,
  locked_until  TEXT,
  updated_at    TEXT NOT NULL
);
