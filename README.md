# 💈 Elite Cuts Barbershop — Commercial H5 WebApp & White-Label PWA

A turnkey, zero-dependency **Progressive Web App (PWA)** built for independent barbershops and agency resellers. It shifts away from heavy WordPress backends and clunky third-party booking marketplaces to provide a lightning-fast, mobile-first experience that clients install straight to their home screen.

---

## ✨ Key Commercial Features

* **⚡ 100% Serverless Architecture:** Runs entirely on static hosting (Vercel, Cloudflare Pages, Netlify) with **$0/month** database or server maintenance costs.
* **📱 Installable PWA:** One-tap home screen installation for iOS Safari and Android Chrome with instant offline app-shell caching via Service Workers (`sw.js`).
* **🪑 4-Step Interactive Booking Engine:** Multi-service combining (cuts, beard sculpts, hot towels), real-time barber selection, date/time conflict locking, and instant `.ics` Calendar / SMS receipt generation.
* **🛡️ No-Show Deposit Protection:** Built-in toggle for Stripe Payment Links or Square Checkout URLs to secure a $15 deposit before locking in prime weekend slots.
* **🔒 Zero-Trust Client-Side Loyalty Vault:** Customer VIP points and 10-cut stamp balances are encrypted locally on their device with time-coded hashing, protecting user privacy and preventing tampering.
* **📊 1-Tap CSV Spreadsheet Export:** Shop owners can download their entire client phone and loyalty database as a `.csv` file to inspect in Excel, Apple Numbers, or Google Sheets.
* **📂 Automated Barber Folder Uploader:** Manager studio automatically organizes uploaded barber photos into clean incremental naming conventions (`firstname_lastname_001.jpg`).
* **🔐 Hidden Manager Portal:** Securely hidden from consumer view and accessed via private URL route (`?portal=admin`, default PIN: `1234`).

---

## 🚀 Quick Deployment Guide

1. Clone or download this repository.
2. Drop `index.html`, `manifest.json`, and `sw.js` into your root directory.
3. Deploy the folder instantly to **Cloudflare Pages** or **Vercel** with zero build commands required.
4. Access your client storefront at `https://your-domain.com` and your manager portal at `https://your-domain.com/?portal=admin`.

---

## 💼 Licensing & Agency Reselling

Designed for digital agencies and independent developers to white-label and license out to local barbers:
* **White-Label Customization:** Change shop names, brand taglines, and primary/accent hex colors instantly in the Manager Studio.
* **Zero Data Liability:** Store zero customer PII on remote servers—everything runs locally and securely on the client's device.
