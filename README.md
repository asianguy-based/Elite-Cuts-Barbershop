# 💈 Elite Cuts Barbershop — Commercial H5 WebApp & White-Label PWA

A turnkey, zero-dependency **Progressive Web App (PWA)** built for independent barbershops and agency resellers. It shifts away from heavy WordPress backends and clunky third-party booking marketplaces to provide a lightning-fast, mobile-first experience that clients install straight to their home screen.

---

## ✨ Key Commercial Features

* **⚡ Serverless Architecture:** Static front end on Cloudflare Pages / Vercel / Netlify. Works stand-alone in demo mode (localStorage only), or pair it with the tiny Cloudflare Worker in `worker/` so the manager portal sees every customer's booking.
* **📱 Installable PWA:** One-tap home screen installation for iOS Safari and Android Chrome with instant offline app-shell caching via Service Workers (`sw.js`).
* **🪑 4-Step Interactive Booking Engine:** Multi-service combining (cuts, beard sculpts, hot towels), real-time barber selection, date/time conflict locking, and instant `.ics` Calendar / SMS receipt generation.
* **🛡️ No-Show Deposit Protection:** Built-in toggle for Stripe Payment Links or Square Checkout URLs to secure a $15 deposit before locking in prime weekend slots.
* **🔒 Loyalty Points & Stamps:** In demo mode balances live in the device's localStorage as an obfuscated (XOR + base64, not encrypted) cache. With the optional Worker backend below, points, stamps, and bookings live in Cloudflare KV and are awarded server-side (deposit points only after payment).
* **📊 1-Tap CSV Spreadsheet Export:** Shop owners can download their entire client phone and loyalty database as a `.csv` file to inspect in Excel, Apple Numbers, or Google Sheets.
* **📂 Automated Barber Folder Uploader:** Manager studio automatically organizes uploaded barber photos into clean incremental naming conventions (`firstname_lastname_001.jpg`).
* **🔐 Hidden Manager Portal:** Accessed via private URL route (`?portal=admin`). Demo-mode PIN is `1234` (hardcoded in the page, so not a real lock); with the Worker backend the PIN is a server secret.

---

## 🚀 Quick Deployment Guide

1. Clone or download this repository.
2. Drop `index.html`, `manifest.json`, and `sw.js` into your root directory.
3. Deploy the folder instantly to **Cloudflare Pages** or **Vercel** with zero build commands required.
4. Access your client storefront at `https://your-domain.com` and your manager portal at `https://your-domain.com/?portal=admin`.

Without a backend the app runs in **demo mode**: bookings, loyalty, and settings exist only in the browser that created them.

---

## ☁️ Backend (Cloudflare Worker)

`worker/` is a dependency-free Cloudflare Worker (`worker/src/index.js` + `worker/wrangler.toml`) backed by one KV namespace. It gives you shared bookings, server-side slot conflict checks, a real manager PIN, server-side loyalty, a loyalty CSV export, and an optional Stripe webhook so deposit points are only awarded once the deposit is actually paid.

```bash
cd worker
npx wrangler kv namespace create BOOKINGS   # paste the returned id into wrangler.toml
npx wrangler secret put MANAGER_PIN         # the real manager PIN
npx wrangler secret put STRIPE_WEBHOOK_SECRET   # optional; enables signature checks on /api/webhook/stripe
npx wrangler deploy
```

Then open the app, go to **Manager Studio → Settings → API URL**, paste the Worker URL (e.g. `https://elite-cuts-api.<you>.workers.dev`), and click *Apply Settings*. Leaving the field blank keeps demo mode. Optionally set `ALLOWED_ORIGIN` in `wrangler.toml` to your Pages origin instead of `*`.

Endpoints: `GET /api/health`, `GET /api/slots?date=&barberId=`, `POST /api/bookings`, `GET /api/loyalty?phone=`, `POST /api/manager/login`, `GET /api/manager/bookings?from=&to=`, `PATCH /api/manager/bookings/:id`, `GET /api/manager/loyalty.csv`, `POST /api/webhook/stripe`. Manager routes require the `X-Manager-Token` header returned by login (valid for the current UTC day).

**Stripe deposits:** the app opens your Payment Link with `client_reference_id=<refCode>`. Point a Stripe webhook for `checkout.session.completed` at `<worker-url>/api/webhook/stripe` and the booking is marked Paid and awarded its 150 pts automatically. Without the webhook, the manager can press **Paid** in the queue.

**Privacy note:** `GET /api/loyalty?phone=` returns points/stamps/recent visits to anyone who knows the phone number. That matches what the current app already exposes (the loyalty tab is a phone lookup), but if you need more, put the Worker behind Cloudflare Access or add an SMS check.

**Static deploy:** the front end stays a plain static site. Deploy the repo root (`index.html`, `manifest.json`, `sw.js`) to Cloudflare Pages with no build step; the Worker is deployed separately from `worker/`.

**Repo note:** `Elite-Cuts-Barbershop.rar` and `Elite-Cuts-Barbershop.txt` describe an older layout (`h5-webapp/` + `wordpress-theme/`); the live app is the flat set of files in the repo root.

---

## 💼 Licensing & Agency Reselling

Designed for digital agencies and independent developers to white-label and license out to local barbers:
* **White-Label Customization:** Change shop names, brand taglines, and primary/accent hex colors instantly in the Manager Studio.
* **Data Footprint:** In demo mode nothing leaves the device. With the Worker backend, bookings and loyalty records (name, phone) are stored in your own Cloudflare KV namespace.
