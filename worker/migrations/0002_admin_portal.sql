-- Admin Portal update: Clear Cancelled, credit-back emails, client reviews.
-- Apply once to an existing database:  npx wrangler d1 migrations apply elite-cuts --remote
-- New shop: run schema.sql first, then the migrations in order.

-- Optional client email (booking form), used to tell a client when wallet credit goes back on their wallet.
ALTER TABLE customers ADD COLUMN email TEXT NOT NULL DEFAULT '';

-- "Clear Cancelled" in the Manager Studio hides cancelled bookings from the queue. The rows stay
-- (wallet refunds and loyalty awards point at them), they just stop showing.
ALTER TABLE bookings ADD COLUMN cleared_at TEXT;

-- Every review a client leaves, plus reviews the manager types in. Only the ticked ones (shown = 1)
-- are copied into the published shop settings that the home screen shows.
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  stars       INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
  text        TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('client', 'manager')),
  shown       INTEGER NOT NULL DEFAULT 0 CHECK (shown IN (0, 1)),
  read_at     TEXT,                         -- NULL = the manager hasn't seen it yet
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS reviews_by_created ON reviews (created_at);

-- Keep the reviews already published on the home screen: copy them into the log, ticked and read.
INSERT INTO reviews (name, stars, text, source, shown, read_at)
SELECT COALESCE(NULLIF(json_extract(r.value, '$.name'), ''), 'Client'),
       MIN(5, MAX(1, COALESCE(CAST(json_extract(r.value, '$.stars') AS INTEGER), 5))),
       json_extract(r.value, '$.text'),
       'manager', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM shop_settings s, json_each(s.data, '$.reviews') r
WHERE s.id = 1 AND COALESCE(json_extract(r.value, '$.text'), '') <> '';
