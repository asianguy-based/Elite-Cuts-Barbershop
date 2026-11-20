// Rewards tab: 10-stamp card + points, looked up by phone number.
import { useState, useEffect } from '../vendor/hooks.module.js';
import { html, Icon } from './ui.js';
import { store, normalizePhone, formatDay } from '../data.js';

function StampCard({ stamps }) {
  return html`
    <ol class="stamps" aria-label=${`${stamps} of 10 stamps collected`}>
      ${Array.from({ length: 10 }, (_, i) => {
        const n = i + 1, on = n <= stamps;
        return html`<li class=${'stamp' + (on ? ' is-on' : '') + (n === 10 ? ' stamp--free' : '')} aria-hidden="true">
          ${on ? Icon.check : html`<span>${n === 10 ? 'Free' : n}</span>`}
        </li>`;
      })}
    </ol>`;
}

export function Rewards() {
  let last = '';
  try { last = localStorage.getItem('ELITE_CUTS_B_LAST_PHONE') || ''; } catch { /* ignore */ }
  const [phone, setPhone] = useState(last);
  const [rec, setRec] = useState(null);
  const [status, setStatus] = useState('');

  async function lookup(e) {
    if (e) e.preventDefault();
    if (!normalizePhone(phone)) { setStatus('Enter the mobile number you booked with.'); setRec(null); return; }
    setStatus('Looking up...');
    try {
      const r = await store.loyalty(phone);
      setRec(r);
      setStatus('');
    } catch {
      setStatus('Could not reach the rewards server. Try again in a moment.');
    }
  }
  useEffect(() => { if (last) lookup(); }, []);

  const stamps = rec ? rec.stamps || 0 : 0;
  return html`
    <section aria-labelledby="rewards-title">
      <header class="hero hero--tight">
        <p class="kicker">Ten cuts, one free</p>
        <h1 id="rewards-title" class="display">Rewards</h1>
      </header>
      <form class="lookup" onSubmit=${lookup}>
        <div class="field">
          <label for="r-phone">Mobile number</label>
          <div class="row row--input">
            <input id="r-phone" type="tel" inputmode="tel" autocomplete="tel" value=${phone} onInput=${(e) => setPhone(e.target.value)} />
            <button type="submit" class="btn btn--primary">Check</button>
          </div>
        </div>
      </form>
      <p class="muted" role="status" aria-live="polite">${status}</p>
      <div class="card-wrap">
        <div class="loyalty-card">
          <div class="loyalty-card__top">
            <p class="display display--sm">Elite Cuts<br/>Stamp card</p>
            <p class="loyalty-card__pts"><span class="display">${rec ? rec.points || 0 : 0}</span><span class="small"> pts</span></p>
          </div>
          <${StampCard} stamps=${stamps} />
          <p class="small">${rec ? (stamps >= 10 ? 'Your next cut is on us.' : `${10 - stamps} more ${10 - stamps === 1 ? 'cut' : 'cuts'} to a free one.`) : 'Check your number to see your stamps.'}</p>
        </div>
        ${rec && html`
          <div class="history">
            <h2 class="h3">Recent visits</h2>
            ${rec.history && rec.history.length ? html`<ul class="history__list">
              ${rec.history.map((h) => html`<li>
                <span><strong>${(h.services || []).join(' + ')}</strong><span class="muted small">${h.date ? formatDay(h.date) : ''} ${h.time || ''} / ${h.barberName || ''}</span></span>
                <span class="pill">${h.refCode || h.status || ''}</span>
              </li>`)}
            </ul>` : html`<p class="muted">No visits on this number yet.</p>`}
          </div>`}
      </div>
    </section>`;
}
