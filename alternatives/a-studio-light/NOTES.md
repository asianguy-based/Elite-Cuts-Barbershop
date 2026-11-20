# Direction A: "Studio Light"

Open `index.html` in this folder to try it. The manager view is at `index.html?portal=admin` (demo PIN 1234).

## What changes compared with the current app

- **Look.** The dark navy and gold is replaced by warm off-white paper, black type and one deep red (oxblood) accent. It uses a classic serif for headings and a plain sans for everything else. There are no gradients, no glass effects and no emoji or icon fonts, so it reads more like a boutique hotel menu card. Phones set to dark mode get a matching warm dark version automatically.
- **Home screen.** Everything is on one scrolling page: shop name, a large "Next available: Today 9:00 am with Mateo — Book it" card, the services laid out like a printed price list, the barbers, hours and address, and the loyalty card. There are no tabs.
- **Booking.** It opens as a panel that slides up over the page, with no separate booking page. The steps are services, then day and time, then name and phone, then confirm. "Any barber" is the default and the customer can narrow to one barber. The price and total time stay visible at the bottom the whole way through.
- **Fewer taps.** "Book it" on the home card skips straight to name and phone, so a first visit takes about 4 taps plus typing. Tapping a service on the price list jumps straight to picking a time.
- **After booking.** The customer sees a reference code (for example EC-4759) and an "Add to calendar" button that downloads a calendar file with a 1-hour reminder.
- **Manager view.** This is one simple day-by-day list: who is coming, what they booked, and their phone number, with buttons for Mark done, Cancel and Mark deposit paid. It shows a daily total and can export the day to a CSV file for Excel or Google Sheets.
- **Barber photos.** The barber photos are replaced by initials in a circle. That keeps the page fast and means it does not depend on stock photos.

## Pros
- It looks calm and premium, and it stands out from typical barbershop templates.
- Customers get to "book" faster because the next free time is the first thing they see.
- It is one file with no outside frameworks, so it loads fast, works on slow phones and has fewer moving parts.
- It works with the same booking server (Cloudflare Worker) as the current app.
- It is easy to read: high contrast, large tap targets, works with a keyboard and screen readers, and supports dark mode.

## Cons and tradeoffs
- It drops some current features: the lookbook/gallery, the in-app settings and white-label screen, the loyalty CSV import, the "install app" banner and the offline service worker. These would need to be added back if you want them.
- The light look is a big change from the current gold-on-navy brand. Regulars may notice.
- Barbers have no photos. Real photos could be added, but they would need to be hosted somewhere.
- Like the current app, availability uses the fixed list of start times (9:00, 10:00 and so on) and only blocks the exact same start time. It does not yet account for a long appointment running into the next slot.
- In demo mode it keeps its own sample bookings on the device, separate from the current app's demo data. The demo adds a few sample bookings so the calendar does not look empty.

## What it would take to adopt it
1. Decide which missing features you need back (gallery, settings screen, install banner). Each is a small, separate job.
2. To take real bookings, put your booking server address in `API_URL` at the top of the script (one line) and keep the manager PIN on the server as you do now.
3. Swap in your own wording, hours and photos if you want them (hours are in the `hours` setting near the top).
4. Replace the current `index.html` with this one (or host it alongside), then test one booking end to end.

Rough effort: about half a day to switch over as-is, and 1 to 2 days to bring back the dropped features.
