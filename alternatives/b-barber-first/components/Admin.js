// Manager view at ?portal=admin: PIN gate, then today's queue as one column per barber.
import { useEffect, useState } from '../vendor/hooks.module.js';
import { html, money, useFocusOnMount } from './ui.js';
import { BARBERS, store, todayKey, slotMinutes, formatDay, bookingsCsv, download, isLive } from '../data.js';

function PinGate({ onUnlock }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const ref = useFocusOnMount();
  async function submit(e) {
    e.preventDefault();
    setErr('');
    let r;
    try { r = await store.managerLogin(pin); } catch { r = { ok: false, error: 'Could not reach the server.' }; }
    if (r.ok) onUnlock(); else setErr(r.error || 'Wrong PIN');
  }
  return html`
    <section class="gate" aria-labelledby="gate-title">
      <p class="kicker">Staff only</p>
      <h1 id="gate-title" class="display" tabindex="-1" ref=${ref}>Manager</h1>
      <form class="form" onSubmit=${submit}>
        <div class="field">
          <label for="pin">PIN</label>
          <input id="pin" type="password" inputmode="numeric" autocomplete="current-password" value=${pin}
            onInput=${(e) => setPin(e.target.value)} aria-describedby="pin-hint" />
          <p id="pin-hint" class="muted small">${isLive() ? 'Checked by the booking server.' : 'Demo mode: PIN is 1234.'}</p>
        </div>
        ${err && html`<p class="notice" role="alert">${err}</p>`}
        <button type="submit" class="btn btn--primary btn--block">Unlock</button>
      </form>
      <p><a class="link" href="./">Back to the shop</a></p>
    </section>`;
}

const STATUS_CLASS = { Completed: 'ok', 'No-Show': 'bad', Cancelled: 'bad', 'Deposit Unpaid': 'warn', Paid: 'ok' };

function QueueCard({ b, onSet }) {
  const closed = ['Completed', 'No-Show', 'Cancelled'].includes(b.status);
  return html`
    <li class=${'qcard' + (closed ? ' is-closed' : '')}>
      <div class="qcard__top">
        <span class="qcard__time">${b.time}</span>
        <span class=${`pill pill--${STATUS_CLASS[b.status] || 'plain'}`}>${b.status}</span>
      </div>
      <p class="qcard__name">${b.clientName}</p>
      <p class="muted small">${(b.services || []).join(' + ')} / ${money(b.totalCost)} / ${b.refCode}</p>
      ${b.notes && html`<p class="small">Note: ${b.notes}</p>`}
      ${!closed && html`<div class="row row--wrap">
        <button type="button" class="btn btn--sm btn--primary" onClick=${() => onSet(b, 'Completed')}>Done<span class="sr-only"> for ${b.clientName}</span></button>
        <button type="button" class="btn btn--sm btn--ghost" onClick=${() => onSet(b, 'No-Show')}>No-show<span class="sr-only"> for ${b.clientName}</span></button>
        ${b.paymentMode === 'deposit' && !b.paid && html`<button type="button" class="btn btn--sm btn--ghost" onClick=${() => onSet(b, 'Paid')}>Deposit paid</button>`}
      </div>`}
      ${closed && html`<button type="button" class="btn btn--sm btn--ghost" onClick=${() => onSet(b, 'Confirmed')}>Undo<span class="sr-only"> for ${b.clientName}</span></button>`}
    </li>`;
}

function Queue() {
  const [date, setDate] = useState(todayKey());
  const [rows, setRows] = useState(null);
  const [msg, setMsg] = useState('');
  const ref = useFocusOnMount();

  async function load() {
    const r = await store.managerBookings(date, date).catch(() => ({ ok: false, error: 'Could not reach the server.' }));
    if (r.ok) setRows(r.bookings); else { setRows([]); setMsg(r.error); }
  }
  useEffect(() => { setRows(null); load(); }, [date]);

  async function onSet(b, status) {
    const r = await store.setStatus(b.id, status).catch(() => ({ ok: false, error: 'Could not reach the server.' }));
    setMsg(r.ok ? `${b.clientName}: ${status}` : `Update failed: ${r.error}`);
    load();
  }
  async function exportLoyalty() {
    try { download('loyalty.csv', await store.loyaltyCsv(), 'text/csv;charset=utf-8'); } catch { setMsg('Loyalty export failed.'); }
  }

  const list = (rows || []).filter((b) => b.status !== 'Cancelled');
  const open = list.filter((b) => !['Completed', 'No-Show'].includes(b.status)).length;
  return html`
    <section class="admin" aria-labelledby="queue-title">
      <header class="admin__head">
        <div>
          <p class="kicker">Manager / ${isLive() ? 'Live' : 'Demo data'}</p>
          <h1 id="queue-title" class="display display--md" tabindex="-1" ref=${ref}>Queue: ${date === todayKey() ? 'Today' : formatDay(date)}</h1>
          <p class="muted">${list.length} booked / ${open} still to come</p>
        </div>
        <div class="admin__tools">
          <div class="field field--inline">
            <label for="q-date">Day</label>
            <input id="q-date" type="date" value=${date} onChange=${(e) => e.target.value && setDate(e.target.value)} />
          </div>
          <button type="button" class="btn btn--primary" onClick=${() => download(`bookings-${date}.csv`, bookingsCsv(rows || []), 'text/csv;charset=utf-8')}>Export CSV</button>
          <button type="button" class="btn btn--ghost" onClick=${exportLoyalty}>Loyalty CSV</button>
          ${!isLive() && html`<button type="button" class="btn btn--ghost" onClick=${() => { store.seedDemoDay(); load(); }}>Add sample day</button>`}
        </div>
      </header>
      <p class="muted small" role="status" aria-live="polite">${msg}</p>
      ${rows === null ? html`<p class="muted">Loading...</p>` : html`
        <div class="columns">
          ${BARBERS.map((br) => {
            const mine = list.filter((b) => b.barberId === br.id).sort((a, c) => slotMinutes(a.time) - slotMinutes(c.time));
            return html`<section class="column" aria-labelledby=${`col-${br.id}`}>
              <h2 id=${`col-${br.id}`} class="column__head"><span>${br.name}</span><span class="count">${mine.length}</span></h2>
              ${mine.length ? html`<ul class="column__list">${mine.map((b) => html`<${QueueCard} key=${b.id} b=${b} onSet=${onSet} />`)}</ul>`
                : html`<p class="muted small column__empty">Nothing booked.</p>`}
            </section>`;
          })}
        </div>`}
      <p><a class="link" href="./">Exit manager view</a></p>
    </section>`;
}

export function Admin() {
  const [unlocked, setUnlocked] = useState(false);
  return unlocked ? html`<${Queue} />` : html`<${PinGate} onUnlock=${() => setUnlocked(true)} />`;
}
