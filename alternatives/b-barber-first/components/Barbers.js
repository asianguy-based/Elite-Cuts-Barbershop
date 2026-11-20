// "Barbers" tab: one big card per barber.
import { html, Avatar } from './ui.js';
import { BARBERS, LOOKS } from '../data.js';
import { Rating, useOpenings, dayLabel } from './BarberSheet.js';
import { LookArt } from './LookArt.js';

function BarberCard({ barber, onProfile, onBook }) {
  const openings = useOpenings(barber.id, 1);
  const next = openings && openings[0];
  const looks = LOOKS.filter((l) => l.barberId === barber.id).slice(0, 3);
  return html`
    <li class="barber-card">
      <div class="barber-card__strip" aria-hidden="true">${looks.map((l) => html`<div class="barber-card__shot"><${LookArt} look=${l} /></div>`)}</div>
      <div class="barber-card__body">
        <div class="profile">
          <${Avatar} barber=${barber} />
          <div>
            <h2 class="display display--sm">${barber.name}</h2>
            <p class="kicker">${barber.role} / ${barber.years} yrs</p>
            <${Rating} barber=${barber} />
          </div>
        </div>
        <ul class="tags" aria-label="Specialties">${barber.specialties.map((s) => html`<li class="tag">${s}</li>`)}</ul>
        <p class="muted small" aria-live="polite">${openings === null ? 'Checking availability...' : next ? `Next open: ${dayLabel(next.date)}, ${next.time}` : 'No openings in the next two weeks'}</p>
        <div class="row">
          <button type="button" class="btn btn--ghost" onClick=${() => onProfile(barber.id)}>Profile<span class="sr-only"> of ${barber.name}</span></button>
          <button type="button" class="btn btn--primary" onClick=${() => onBook(barber.id, null, null)}>Book ${barber.first}</button>
        </div>
      </div>
    </li>`;
}

export function Barbers({ onProfile, onBook }) {
  return html`
    <section aria-labelledby="barbers-title">
      <header class="hero hero--tight">
        <p class="kicker">The chairs</p>
        <h1 id="barbers-title" class="display">Barbers</h1>
      </header>
      <ul class="barber-list">${BARBERS.map((b) => html`<${BarberCard} key=${b.id} barber=${b} onProfile=${onProfile} onBook=${onBook} />`)}</ul>
    </section>`;
}
