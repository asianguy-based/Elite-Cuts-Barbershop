// Barber profile: opened from a look tile or the Barbers tab.
import { useEffect, useState } from '../vendor/hooks.module.js';
import { html, Sheet, Icon, Avatar } from './ui.js';
import { LookTile } from './Feed.js';
import { LOOKS, barberById, store, formatDay, todayKey, addDays } from '../data.js';

export function useOpenings(barberId, count = 3) {
  const [openings, setOpenings] = useState(null);
  useEffect(() => {
    let alive = true;
    setOpenings(null);
    store.nextOpenings(barberId, count).then((o) => alive && setOpenings(o)).catch(() => alive && setOpenings([]));
    return () => { alive = false; };
  }, [barberId]);
  return openings;
}

export function dayLabel(key) {
  if (key === todayKey()) return 'Today';
  if (key === addDays(todayKey(), 1)) return 'Tomorrow';
  return formatDay(key, { weekday: 'short', month: 'short', day: 'numeric' });
}

export function Rating({ barber }) {
  return html`<span class="rating"><span class="accent">${Icon.star}</span> ${barber.rating}<span class="muted"> / ${barber.reviews} reviews</span></span>`;
}

export function BarberSheet({ barberId, look, onClose, onBook, onOpenLook }) {
  const barber = barberById(barberId);
  const openings = useOpenings(barberId, 4);
  const theirLooks = LOOKS.filter((l) => l.barberId === barberId);
  return html`
    <${Sheet} label=${`${barber.name} profile`} onClose=${onClose}>
      <div class="profile">
        <${Avatar} barber=${barber} size="lg" />
        <div>
          <p class="kicker">${barber.role} / ${barber.years} yrs</p>
          <h2 class="display display--md">${barber.name}</h2>
          <p class="muted">${barber.handle}</p>
          <${Rating} barber=${barber} />
        </div>
      </div>
      ${look && html`<p class="picked">You tapped <strong>${look.name}</strong>. ${barber.first} cuts this one.</p>`}
      <p>${barber.bio}</p>
      <ul class="tags" aria-label="Specialties">${barber.specialties.map((s) => html`<li class="tag">${s}</li>`)}</ul>

      <h3 class="h3">Next openings</h3>
      ${openings === null ? html`<p class="muted" role="status">Checking the book...</p>`
        : openings.length === 0 ? html`<p class="muted">Fully booked for the next two weeks.</p>`
        : html`<ul class="openings">
            ${openings.map((o) => html`<li>
              <button type="button" class="slot" onClick=${() => onBook(barberId, look, o)}
                aria-label=${`Book ${barber.first} ${dayLabel(o.date)} at ${o.time}`}>
                <span class="slot__day">${dayLabel(o.date)}</span><span class="slot__time">${o.time}</span>
              </button></li>`)}
          </ul>`}

      <h3 class="h3">${barber.first}'s work</h3>
      <ul class="grid grid--mini" aria-label=${`Looks by ${barber.name}`}>
        ${theirLooks.map((l, i) => html`<${LookTile} key=${l.id} look=${l} index=${i} compact onOpen=${(x) => onOpenLook(x)} />`)}
      </ul>

      <div class="sheet__cta">
        <button type="button" class="btn btn--primary btn--block" onClick=${() => onBook(barberId, look, null)}>Book with ${barber.first}</button>
      </div>
    <//>`;
}
