# 💈 Elite Cuts Barbershop — Commercial H5 WebApp & White-Label PWA

A turnkey, zero-dependency **Progressive Web App (PWA)** built for independent barbershops and agency resellers. It shifts away from heavy WordPress backends and clunky third-party booking marketplaces to provide a lightning-fast, mobile-first experience that clients install straight to their home screen.

---

## ✨ Key Commercial Features

* **⚡ Serverless Architecture:** Static front end on Cloudflare Pages / Vercel / Netlify. Works stand-alone in demo mode (localStorage only), or pair it with the tiny Cloudflare Worker in `worker/` so the manager portal sees every customer's booking.
* **📱 Installable PWA:** One-tap home screen installation for iOS Safari and Android Chrome with instant offline app-shell caching via Service Workers (`sw.js`).
* **🪑 4-Step Interactive Booking Engine:** Multi-service combining (cuts, beard sculpts, hot towels), real-time barber selection, date/time conflict locking, and instant `.ics` Calendar / SMS receipt generation.
* **🛡️ No-Show Deposit Protection:** Built-in toggle for Stripe Payment Links or Square Checkout URLs to secure a $15 deposit before locking in prime weekend slots.
* **🔒 Loyalty Points & Stamps:** In demo mode balances live in the device's localStorage as an obfuscated (XOR + base64, not encrypted) cache. With the optional Worker backend below, points, stamps, and bookings live in a Cloudflare D1 database and are awarded server-side (deposit points only after payment).
* **⭐ Client Reviews:** A "What Clients Say" section on the home screen, edited in the manager portal (one review per line: `Name | Stars | Review`). The demo ships three reviews clearly labeled as samples, and the rating tile is worked out from the reviews entered, never a made-up score or count.
* **📊 1-Tap CSV Spreadsheet Export:** Shop owners can download their entire client phone and loyalty database as a `.csv` file to inspect in Excel, Apple Numbers, or Google Sheets.
* **📂 Automated Barber Folder Uploader:** Manager studio automatically organizes uploaded barber photos into clean incremental naming conventions (`firstname_lastname_001.jpg`).
* **🔐 Hidden Manager Portal:** Accessed via private URL route (`?portal=admin`). Demo-mode PIN is `1234` (hardcoded in the page, so not a real lock); with the Worker backend the PIN is a server secret.

---

## 🚀 Quick Deployment Guide

1. Clone or download this repository.
2. Deploy the repo root folder as-is: `index.html`, `manifest.json`, `sw.js`, plus the `css/` and `js/` folders. Keep the folder structure; the page loads its styles and scripts from those relative paths.
3. Deploy the folder instantly to **Cloudflare Pages** or **Vercel** with zero build commands required. (Serve it over http(s); the app uses ES modules, so double-clicking `index.html` from disk won't boot it. For a quick local look, run `python3 -m http.server` in the folder.)
4. Access your client storefront at `https://your-domain.com` and your manager portal at `https://your-domain.com/?portal=admin`.

Without a backend the app runs in **demo mode**: bookings, loyalty, and settings exist only in the browser that created them.

### 🗂️ File Layout

Still zero-build: plain HTML, CSS, and native ES modules, no bundler.

```
index.html        markup only (+ Tailwind / Font Awesome / Google Fonts CDNs)
manifest.json     PWA manifest
sw.js             service worker; APP_SHELL lists every file cached for offline use
css/app.css       theme variables and custom styles
js/main.js        entry point: boots the app, registers sw.js, exposes inline onclick handlers on window
js/config.js      DEFAULT_CONFIG (services, barbers, time slots, deposit) + saved tenant settings
js/api.js         Worker API wrapper (demo mode when no API URL is set)
js/storage.js     bookings, loyalty DB, on-device LoyaltyVault
js/booking.js     4-step booking wizard, time slots, "Next open chair" card, .ics / SMS receipts
js/loyalty.js     VIP wallet lookup and punch card
js/admin.js       manager portal: queue, barber folders, CSV, white-label settings
js/ui.js          theme, home + lookbook rendering, tabs, PWA install banner
tests/e2e.mjs     Playwright regression suite (`node tests/e2e.mjs`; never touches the live API)
```

If you add a CSS or JS file, add it to `APP_SHELL` in `sw.js` and bump `CACHE_NAME` so installed apps pick it up.

### 🔄 Releasing an update

The app is installed from the browser, not an app store, so it tells people about new versions itself. On every deploy, edit the top of `sw.js`:

1. Bump `CACHE_NAME` (e.g. `elite-cuts-h5-v1.4.0` → `v1.4.1`).
2. Set `RELEASE_NOTES` to one short sentence about what changed.

Open apps (iPhone and Android home-screen installs and browser tabs) check for a new version when they open, when they come back to the foreground and every 30 minutes. When one is ready they show a popup, **UPDATE: <your release notes>** with an **OK** button; OK switches to the new version and reloads. `js/update.js` holds that logic; `node --test tests/app-update.test.mjs` tests it.

---

## ☁️ Backend (Cloudflare Worker)

`worker/` is a dependency-free Cloudflare Worker (`worker/src/index.js` + `worker/wrangler.toml`) backed by one D1 (SQLite) database. It gives you shared bookings, double-booking protection enforced by the database itself (two clients can never hold the same barber, date and time), a real manager PIN, server-side loyalty, a loyalty CSV export, and an optional Stripe webhook so deposit points are only awarded once the deposit is actually paid.

```bash
cd worker
npx wrangler d1 create elite-cuts                             # paste the returned database_id into wrangler.toml
npx wrangler d1 execute elite-cuts --remote --file=schema.sql
npx wrangler d1 migrations apply elite-cuts --remote          # online payments + VIP wallet tables (worker/migrations/)
npx wrangler secret put MANAGER_PIN         # the real manager PIN
npx wrangler secret put STRIPE_SECRET_KEY       # optional; a TEST key (sk_test_...) turns on Stripe Checkout
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # recommended; verifies signatures on /api/webhook/stripe
npx wrangler deploy
```

Then open the app, go to **Manager Studio → Settings → API URL**, paste the Worker URL (e.g. `https://elite-cuts-api.<you>.workers.dev`), and click *Apply Settings*. Leaving the field blank keeps demo mode. `ALLOWED_ORIGIN` in `wrangler.toml` is a comma-separated list of browser origins allowed to call the API; `https://*.your-project.pages.dev` also covers Pages preview deploys. Add your custom domain there if you add one (`*` allows any site).

Endpoints: `GET /api/health`, `GET /api/slots?date=&barberId=`, `POST /api/bookings`, `GET /api/loyalty?phone=`, `POST /api/manager/login`, `POST /api/manager/logout`, `GET /api/manager/bookings?from=&to=`, `PATCH /api/manager/bookings/:id`, `GET /api/manager/loyalty.csv`, `GET /api/manager/report?from=&to=` (bookings, no-shows and revenue per barber per day), `GET /api/shop` (the published shop profile), `PUT /api/manager/shop` (publish it), `POST /api/bookings/late` (client says they are running late), `POST /api/webhook/stripe`. Manager routes require the `X-Manager-Token` header returned by login. Each login gets its own random token that lasts 12 hours or until logout (closing the Manager Studio logs out); only a hash of it is stored.

**Stripe deposits:** the app opens your Payment Link with `client_reference_id=<refCode>`. Point a Stripe webhook for `checkout.session.completed` at `<worker-url>/api/webhook/stripe` and the booking is marked Paid and awarded its 150 pts automatically. Without the webhook, the manager can press **Paid** in the queue.

**Online payments (Stripe Checkout):** with a Stripe secret key set on the Worker, clients can pick at booking: a **deposit** (amount set by the manager), **prepay in full** (priced on the server from the published services), **VIP wallet credit** (store credit per phone number, protected by a 4-6 digit PIN that the first top-up sets), or **pay at chair**. The manager turns each option on or off and sets the deposit and the wallet top-up amounts in **Settings → Online Payments**, and can add or remove wallet credit and reset a wallet PIN in the Studio. Deposits, prepay and top-ups go through Stripe Checkout created by the Worker; the webhook marks the booking Paid or credits the wallet, once. An unpaid checkout expires after about 30 minutes and its booking is cancelled, freeing the slot. Cancelling a wallet booking puts the credit back. Card refunds are done in the Stripe dashboard.

Test mode only by default: the Worker creates Checkout only with a `sk_test_`/`rk_test_` key. A live key is ignored (the app falls back to the Payment Link) unless you also set the variable `STRIPE_ALLOW_LIVE="true"`. Add a webhook in the Stripe dashboard at `<worker-url>/api/webhook/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired`. New endpoints: `GET /api/payments` (what's switched on), `POST /api/wallet` (balance + history, needs the PIN), `POST /api/wallet/topup`, `GET /api/manager/wallets`, `POST /api/manager/wallets/:phone/adjust`, `POST /api/manager/wallets/:phone/reset-pin`. Deploy the Worker (and run the migration) **before** the front end, then press **Apply Settings** once so the new settings are published.

**Privacy note:** `GET /api/loyalty?phone=` returns points/stamps/recent visits to anyone who knows the phone number. That matches what the current app already exposes (the loyalty tab is a phone lookup), but if you need more, put the Worker behind Cloudflare Access or add an SMS check.

**Static deploy:** the front end stays a plain static site. Deploy the repo root (`index.html`, `manifest.json`, `sw.js`, `css/`, `js/`) to Cloudflare Pages with no build step; the Worker is deployed separately from `worker/`.

**Stripe webhook security:** the webhook never trusts an unauthenticated "paid" message. With `STRIPE_WEBHOOK_SECRET` set it checks Stripe's signature; without it, but with `STRIPE_SECRET_KEY` set, it asks Stripe directly whether the checkout session was paid; with neither, it refuses and the manager marks deposits paid by hand.

**Manager PIN lockout:** after 5 wrong PINs from one IP address (one IPv6 /64), login is locked for 15 minutes. After 100 wrong PINs shop-wide in an hour, all logins pause until the hour is up, so guessing from many addresses doesn't work either. Use a PIN of 8 or more digits.

**Abuse limits:** each address can make 10 bookings, 30 loyalty lookups and 10 "running late" calls an hour. Bookings must use a real slot label (`09:00 AM`), a simple barber id and a date between today and 120 days out. Pay-at-chair points (100) are awarded when the manager marks the visit **Done**, not at booking, so fake bookings earn nothing.

**Shop settings are shared:** with the Worker backend, everything edited in the Manager Studio (shop name, tagline, colors, payment link, reviews and the sample label, barbers and their photos) is saved to the database through `PUT /api/manager/shop`, and every client loads it from `GET /api/shop` when the app opens. Before this, those edits only existed in the browser that made them. The API checks every field (type, length, colors as `#rrggbb`, links must be `https://`, photos must be PNG/JPEG/WebP/GIF under about 300 KB; uploads are shrunk to 320 px first) and refuses any other key. The API URL stays per device. The first time a shop logs in after upgrading, the studio says the settings aren't published yet: press **Apply Settings** once to publish them. Once published, bookings must name one of the shop's barbers and time slots, and the barber's name is taken from the server.

**Upgrading an existing shop:** re-run `npx wrangler d1 execute elite-cuts --remote --file=schema.sql` before deploying this version (it adds the `manager_sessions`, `rate_limits` and `shop_settings` tables; existing data is untouched).

**Manager Studio tabs (v1.6.0):** the admin portal is split into four tabs so it doesn't become one long scroll: **Appointments** (queue with **Clear Cancelled**, plus a month calendar), **Barber Roster** (barber folders and roster), **Customer VIP Information** (VIP wallet credit and the loyalty spreadsheet) and **Admin** (Application Settings, Client Reviews, and Import/Export Barbershop Settings). Clear Cancelled hides cancelled bookings on the server (`cleared_at`), so it works in live mode too; the rows are kept for history.

**Client reviews:** clients leave one from the home screen (`POST /api/reviews`, 3 an hour per address). Every review is logged in the `reviews` table, unread until the manager opens the Admin tab, and only the ones ticked **Show** appear on the home screen. Run `npx wrangler d1 migrations apply elite-cuts --remote` (migration `0002_admin_portal.sql`) before deploying this Worker; reviews already on the home screen are carried into the log, ticked.

**Credit-back email:** when the manager cancels a booking paid from the VIP wallet, the credit goes back once and the client's phone number is taken off that cancelled appointment (the wallet and loyalty account are kept). If the client gave an email when booking, the Worker emails them through [Resend](https://resend.com): set `npx wrangler secret put RESEND_API_KEY` and `EMAIL_FROM` under `[vars]` (an address on a domain verified in Resend). Without them the credit still goes back and the manager is told the email isn't set up.

**Tests:** `cd worker && npm test` runs the Worker end to end against the real `schema.sql` plus every migration (payments are tested against a fake Stripe) using Node 22+'s built-in SQLite (no Cloudflare account needed). `node --test tests/shared-settings.test.mjs` checks the app's settings code against that same Worker.

---

## 💼 Licensing & Agency Reselling

Designed for digital agencies and independent developers to white-label and license out to local barbers:
* **White-Label Customization:** Change shop names, brand taglines, and primary/accent hex colors instantly in the Manager Studio.
* **Data Footprint:** In demo mode nothing leaves the device. With the Worker backend, bookings and loyalty records (name, phone) are stored in your own Cloudflare D1 database.
