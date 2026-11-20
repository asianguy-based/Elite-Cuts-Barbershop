# Design alternatives

Three other directions the Elite Cuts app could have taken. Each is runnable in demo mode (open its `index.html`; manager view at `?portal=admin`, PIN 1234) and has a `NOTES.md` with pros, cons and adoption steps. None of them replaces the live app; they are here for comparison.

| Folder | Direction | What changes |
|---|---|---|
| `a-studio-light/` | Studio Light | Light editorial look; "next open chair → Book it" home card; booking in a slide-up sheet. Same Worker. |
| `b-barber-first/` | Barber-first portfolio | Home is a grid of cuts by barber; book from the barber's profile. Code split into Preact + htm components (no build step). Same Worker. |
| `c-text-to-book/` | Text to book | Booking as a scripted chat; "same as last time" and "running late". New Worker on Cloudflare D1 with database-enforced no-double-booking (`worker/`, `npm test`). |
