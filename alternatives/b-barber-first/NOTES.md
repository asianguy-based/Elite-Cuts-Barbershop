# Direction B: Barber-first portfolio

## The idea

Most people pick a barber by looking at their work, the same way they would scroll Instagram. So this version opens on a grid of haircuts ("Skin Fade", "Low Taper", "Textured Crop" and so on), each tagged with the barber who cut it. Tapping a look opens that barber's profile, and booking starts from there.

## What changes for customers

- **Home is a gallery of cuts.** The current app opens on a menu of services. This one opens on haircuts, and you can filter them by barber.
- **Tapping a look opens the barber's profile:** rating, specialties, a short bio, more of their work and their **next 4 open times**. Tapping one of those times jumps you most of the way through booking.
- **Booking is 3 steps, with the barber already chosen:** service (already filled in to match the look you tapped) → day and time → name, phone and payment choice. The confirmation screen shows a big reference code and an "Add to calendar" button. The calendar file now has the real start and end time, which the current one is missing.
- **The Barbers tab** has one card per barber, with three of their cuts, their specialties and their next opening.
- **The Rewards tab** has a 10-stamp card (the 10th is free) and your points, looked up by phone number. After you book, it fills in your number for you.
- **The look:** near-black and white with one signal red, big condensed uppercase lettering and square edges. There is no gold, no glass effect and no emoji. On phones there is a tab bar at the bottom; on computers the menu is at the top.
- **The manager view** is still at `?portal=admin` (demo PIN 1234). It now shows each day as **one column per barber**, sorted by time. Each booking has Done, No-show, Deposit paid and Undo buttons, plus Export CSV for that day's bookings and Loyalty CSV for the rewards list. A date picker lets you look at other days. In demo mode, "Add sample day" fills today with example bookings.

## What changes under the hood

The current app is one 1,300-line file that builds every screen by pasting text together. This version is split into small, named pieces:

| File | What it is |
|---|---|
| `index.html` | A near-empty shell page |
| `app.js` | Decides which screen is showing |
| `data.js` | Shop details, services, barbers and looks, plus the one place that saves and loads bookings |
| `components/*.js` | One file per screen part: Feed, BarberSheet, BookingFlow, Barbers, Rewards, Admin, Nav, and the drawn look tiles |
| `styles.css` | All the styling |
| `vendor/` | Preact and htm (a tiny 15 KB UI toolkit, stored locally) and the Anton display font |

There is no build step: you upload the folder as it is. The app does not rely on outside services (no Tailwind, Font Awesome or Google Fonts), so it loads quickly and still works if those services go down.

**Backend.** `data.js` has `API_URL` at the top. If it is left empty, the app runs in demo mode and saves everything in the browser. If you set it to your Cloudflare Worker's address, the app uses the same Worker and the same requests as today: booking, available times, rewards lookup, manager login, the bookings list, status changes and the loyalty CSV. The Worker does not need any changes.

## Pros

- It sells the barbers. Clients see the work before the price list, which suits a shop whose barbers have their own followings.
- Getting to a booking is quicker: tap a look, tap an open time, enter your name and phone, confirm.
- The manager's day reads like a whiteboard: one column per chair.
- The code is much easier to change safely. To edit the rewards screen you open `Rewards.js`, and nothing else is affected. A developer will find it far easier to pick up than one huge file.
- Accessibility: every control is a real button or a labelled field, there are clear focus outlines and strong contrast, and the profile panel closes with the Escape key and keeps keyboard focus inside it. Animations are switched off for people who ask their device for reduced motion. Checked with no sideways scrolling at 360 px wide.

## Cons and tradeoffs

- **It only works with real photos.** The cut pictures here are drawn placeholders. To be convincing, each barber needs to supply roughly 6–12 good, consistent photos and keep them current. Without that, this design is weaker than the current one.
- People who just want "any barber, soonest time" have one extra step. A "first available" button would fix that.
- The streetwear style is bold. It suits a younger, fashion-minded clientele and may feel less "luxury lounge" than the navy and gold.
- Some features of the current app are not rebuilt yet: the settings screen for shop name, colours and adding barbers (in this version those are edited in `data.js`), loyalty CSV import, the "Text the shop" confirmation, installing the app to a phone's home screen with offline support (no manifest or service worker yet), and the encrypted rewards copy kept on the phone.
- A small UI library (Preact) is now part of the app. It is stored in the folder, so there is nothing to install, but a developer needs to know how it works.

## What adopting it would take

1. Photos: about 6–12 per barber, square or portrait. Swap the drawn tiles for photos in `LookArt.js` / `data.js` (about an hour).
2. Fill in the real barbers, their bios and the looks in `data.js`, set `API_URL` to the existing Worker, and set the Stripe payment link if you take deposits.
3. Bring over the missing pieces listed above (about 1–2 days of work), especially home-screen install and offline support if that matters to you.
4. Test it against the live Worker with a real PIN, then put it in place of the current `index.html`. The booking data stays where it is because the Worker does not change.
