# Direction C: "Text to book"

Open `index.html` to try it. It runs in demo mode, so everything is saved in your browser. The manager inbox is at `index.html?portal=admin` and the PIN is **1234**.

## What changes

**For clients.** Booking works like texting the shop. The shop sends a greeting and some quick-reply buttons: *Book a cut*, *My points*, *Hours & location* and *Running late*. A booking goes like this:

1. Tap one or more services.
2. Pick a barber. "Anyone" is the default.
3. Tap a day, then tap one of the open times.
4. Type your name and mobile number.
5. Check the summary and tap **Confirm** or **Change**.

You then get a reference code, an **Add to calendar** button with a 1-hour reminder, and Directions.

Returning clients are remembered on their phone: *"Same as last time? Executive Cut with Marcus."* A repeat booking takes about five taps. *Running late* lets a client say "10 min late", and that shows up as a tag in the manager inbox.

The chat follows a fixed script. There is no AI, so it can't say anything you haven't approved. If someone types "what are your hours", it still goes to the right answer.

**Look.** Cool and calm: blue-grey backgrounds with deep teal as the only accent colour, so it reads like a modern messaging app rather than a traditional barbershop. It uses one clean typeface (Figtree), with bold weights for headings. Light and dark modes follow the phone's setting, all text meets accessibility contrast standards (WCAG AA), and text is 16px or larger. The typing dots are subtle, and animations switch off for people who turn off motion. On a computer screen there is a shop card beside the chat with hours, address and barbers.

**For you (manager).** An inbox of bookings grouped by day, with a status tag on each one. You can:
- mark a booking Done, No-show or Cancelled
- mark a deposit as paid
- search by name, phone or reference
- filter to Upcoming, Today or All
- export to CSV

**Backend (`worker/`).** It offers the same web addresses and data as the current worker, so the current app could use it too. The difference is that it stores data in **Cloudflare D1**, a real SQL database, instead of KV.

## Why D1 instead of KV

- **No double bookings.** KV is "eventually consistent": a write can take up to a minute to reach every Cloudflare location. Two people booking Marcus at 11:00 within that window can both succeed. D1 has a rule saying a barber can have only one active booking per date and time. When two people race, the database accepts exactly one and the other is told "that time was just taken" and offered other times. A cancelled slot opens up again automatically.
- **All or nothing.** The customer, the booking and the loyalty points are saved together, or not at all.
- **Points can't drift or be counted twice.** Points come from a ledger (`loyalty_events`), and each booking can earn each kind of award only once. If Stripe sends the same payment notice twice, the client still gets the points only once.
- **Real reports.** Questions like "revenue per barber per day" become one database query (`/api/manager/report`). With KV the code has to load every record one by one.

## Security notes

- Stripe payment notices are checked with the same signature check (HMAC) as the original, and notices older than 5 minutes are rejected. Unlike the original, the worker **refuses** Stripe notices when no Stripe secret is set.
- Only sites on an allow-list can call the API from a browser (`ALLOWED_ORIGINS`). Calls from any other website get a "403 forbidden" error.

## Pros

- It feels personal and familiar. Most people already know how to text, and a repeat booking is very fast.
- The chat works well on small phones, because there is no form to fill in.
- *Running late* and *My points* are built into the same conversation.
- Double bookings become impossible, not just unlikely, and reporting gets much easier.

## Cons and tradeoffs

- **Slower for people who know exactly what they want** in a first booking. They can't see every service, barber and time on one screen and jump straight to one.
- Looking around ("show me Saturday afternoons for both barbers") is harder in a chat than on a calendar grid.
- It is not real SMS. It is a web page that looks like texting. Real texting would need Twilio or similar, plus an SMS bill.
- Clients are only recognised on the device they booked from. A new phone means typing the number once more.
- D1 needs a one-time database setup, and there is a schema to look after when things change.

## What adopting it would take

1. Decide whether the chat replaces the current booking screen or sits next to it as a "Text to book" option.
2. Backend (about an hour, by someone comfortable with a terminal). Follow the comments in `worker/wrangler.toml`:
   - create the D1 database
   - run `schema.sql`
   - set the `MANAGER_PIN` and `STRIPE_WEBHOOK_SECRET` secrets
   - set `ALLOWED_ORIGINS` to the site's address
   - deploy
3. Put the worker's address into `const API_URL` at the top of `index.html`.
4. Optional: copy existing KV bookings and loyalty records into D1 with a one-off script. None is included.
5. Optional: connect real SMS later. The script logic could drive it.

## Checks I ran

- **Backend tests:** `cd worker && npm test` runs 9 end-to-end tests with Node's built-in SQLite and the real `schema.sql`. They cover:
  - booking, slots and loyalty
  - 409 on double booking, with nothing half-saved
  - several simultaneous requests for one slot, where exactly one wins
  - re-booking a cancelled slot
  - manager PIN and token
  - CSV and the report
  - Stripe signature, the replay window and paying only once
  - running late
  - CORS
  - bad input
- **Database rules:** the schema was also loaded in Python's SQLite. A duplicate active slot is blocked, and a slot can be re-booked after a cancel.
- **Browser test (Playwright):** run at 390×844 (phone) and 1280×800 (computer), with no page errors. It covered:
  - a full chat booking and the .ics calendar file
  - points, hours and running late
  - free typing
  - a returning client's "same as last time"
  - Start over
  - a wrong and a right PIN in the manager inbox
  - Done and CSV export
  - dark mode with animations turned off
- **Not tested:** nothing was deployed, and I didn't run the worker inside Cloudflare's own tools (Wrangler or Miniflare).
