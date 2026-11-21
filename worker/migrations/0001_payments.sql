-- Payments: booking deposits, full prepay and the VIP wallet (store credit), all through Stripe Checkout.
-- Apply once to an existing database:  npx wrangler d1 migrations apply elite-cuts --remote
-- (wrangler records it in d1_migrations, so it never runs twice). New shop: run schema.sql first, then this.

-- bookings.payment_mode keeps its old values ('deposit' = paid online, 'chair' = pay in the shop): its CHECK
-- can't be changed without rebuilding the table. pay_option says which online option was used.
ALTER TABLE bookings ADD COLUMN pay_option TEXT CHECK (pay_option IS NULL OR pay_option IN ('deposit', 'prepay', 'wallet', 'chair'));
ALTER TABLE bookings ADD COLUMN amount_due REAL NOT NULL DEFAULT 0;   -- dollars to pay online (deposit or full price)
ALTER TABLE bookings ADD COLUMN stripe_session_id TEXT;              -- Checkout Session that collects amount_due
CREATE INDEX IF NOT EXISTS bookings_by_stripe_session ON bookings (stripe_session_id) WHERE stripe_session_id IS NOT NULL;

-- VIP wallet: one account per phone (digits only), protected by a 4-6 digit PIN (PBKDF2 hash, never the PIN).
-- pin_hash NULL = no PIN yet (or the manager reset it): the next request that sends a PIN sets it.
CREATE TABLE IF NOT EXISTS wallet_accounts (
  phone       TEXT PRIMARY KEY CHECK (phone <> '' AND phone NOT GLOB '*[^0-9]*'),
  name        TEXT NOT NULL DEFAULT '',
  pin_hash    TEXT,
  pin_salt    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Append-only ledger in cents; the balance is the sum. A spend row is written only when the balance covers it
-- (the worker makes the amount NULL otherwise, which this NOT NULL refuses and rolls the booking back).
CREATE TABLE IF NOT EXISTS wallet_ledger (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  phone              TEXT NOT NULL REFERENCES wallet_accounts(phone),
  kind               TEXT NOT NULL CHECK (kind IN ('topup', 'spend', 'refund', 'adjustment')),
  amount_cents       INTEGER NOT NULL,
  booking_id         TEXT,
  stripe_session_id  TEXT,
  note               TEXT NOT NULL DEFAULT '',
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
-- Stripe retries webhooks: a top-up is credited once per Checkout Session, a booking is spent/refunded once.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_topup_once ON wallet_ledger (stripe_session_id) WHERE stripe_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS wallet_once_per_booking ON wallet_ledger (booking_id, kind) WHERE booking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wallet_by_phone ON wallet_ledger (phone, created_at);
