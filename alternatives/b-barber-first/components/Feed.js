// Home: a grid of haircut looks, filterable by barber. Tap a look -> barber sheet.
import { useState } from '../vendor/hooks.module.js';
import { html } from './ui.js';
import { LookArt } from './LookArt.js';
import { LOOKS, BARBERS, barberById } from '../data.js';

export function LookTile({ look, index, onOpen, compact = false }) {
  const barber = barberById(look.barberId);
  return html`
    <li class=${'tile' + (compact ? ' tile--compact' : '')}>
      <button type="button" class="tile__btn" onClick=${() => onOpen(look)}
        aria-label=${`${look.name} by ${barber.name}. View barber and book.`}>
        <${LookArt} look=${look} />
        <span class="tile__num" aria-hidden="true">${String(index + 1).padStart(2, '0')}</span>
        <span class="tile__label" aria-hidden="true">
          <span class="tile__name">${look.name}</span>
          <span class="tile__by">${barber.handle}</span>
        </span>
      </button>
    </li>`;
}

export function Feed({ onOpenLook }) {
  const [filter, setFilter] = useState('all');
  const looks = filter === 'all' ? LOOKS : LOOKS.filter((l) => l.barberId === filter);
  const chips = [{ id: 'all', label: 'All looks' }, ...BARBERS.map((b) => ({ id: b.id, label: b.first }))];
  return html`
    <section aria-labelledby="feed-title">
      <header class="hero">
        <p class="kicker">Book by the look</p>
        <h1 id="feed-title" class="display">Pick the cut.<br/><span class="accent">Meet the barber.</span></h1>
        <p class="lede">Every look here was cut in our chairs. Tap one to see who did it and grab their next opening.</p>
      </header>
      <div class="chips" role="group" aria-label="Filter looks by barber">
        ${chips.map((c) => html`
          <button type="button" class="chip" aria-pressed=${filter === c.id ? 'true' : 'false'} onClick=${() => setFilter(c.id)}>${c.label}</button>`)}
      </div>
      <ul class="grid" aria-label="Haircut looks">
        ${looks.map((l, i) => html`<${LookTile} key=${l.id} look=${l} index=${i} onOpen=${onOpenLook} />`)}
      </ul>
    </section>`;
}
